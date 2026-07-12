// node test/engine.test.mjs
//
// Drives the real mod/setup.mjs against a fake Melvor + fake Enchanting mod. The fakes are
// deliberately faithful where it matters: the skill's action() self-restarts on the same item
// (which is what forces the mod to interrupt an enchant), createEnchantingItem() returns a
// brand-new item object each grade, costs are checked against a real bank, and the loot path
// rolls a quality before deciding what to do with it.
//
// The panel is real too — the fake DOM records what the mod builds, and the tests click the
// same buttons you would.

const results = [];
const check = (name, pass, extra = "") => {
  if (process.env.TRACE) console.error(`… ${name}`);
  results.push({ name, pass, extra });
};

// ---- fake DOM -------------------------------------------------------------

const mkClassList = () => {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
  };
};

const mkEl = (tag = "div") => ({
  tag,
  children: [],
  listeners: {},
  classList: mkClassList(),
  style: {},
  textContent: "",
  value: "",
  checked: false,
  disabled: false,
  multiple: false,
  selectedOptions: [],
  append(...kids) {
    this.children.push(...kids);
  },
  prepend(...kids) {
    this.children.unshift(...kids);
  },
  replaceChildren(...kids) {
    this.children = kids;
  },
  after(node) {
    container.children.push(node);
  },
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  },
  fire(type) {
    for (const fn of this.listeners[type] ?? []) fn();
  },
  querySelector: (sel) => (sel === ".skill-info" ? skillInfo : null),
  setAttribute() {},
});

const container = mkEl("div");
const skillInfo = mkEl("div");

globalThis.document = {
  head: mkEl("head"),
  body: mkEl("body"),
  createElement: (tag) => mkEl(tag),
  createTextNode: (text) => ({ tag: "#text", textContent: text, children: [] }),
  getElementById: (id) => (id === "enchanting-container" ? container : null),
};

const walk = (node, out = []) => {
  for (const child of node.children ?? []) {
    out.push(child);
    walk(child, out);
  }
  return out;
};

// Each section carries an <h4> caption; each control sits in a box whose first child is a
// <span> naming it. Finding things that way keeps the tests readable and independent of the
// order the mod happens to build its nodes in.
const sectionByTitle = (title) =>
  walk(container).find((node) => (node.children ?? []).some((c) => c.tag === "h4" && c.textContent === title));
const controlIn = (root, label) =>
  walk(root).find((node) => node.children?.[0]?.tag === "span" && node.children[0].textContent === label)
    ?.children[1];
const buttonsIn = (root) => walk(root).filter((node) => node.tag === "button");

// ---- fake game ------------------------------------------------------------

const QUALITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];
const ESSENCE = QUALITIES.map((q) => ({ id: `enchanting:${q}_Essence`, name: `${q} Essence` }));

const platebody = { id: "melvorD:Dragon_Platebody", name: "Dragon Platebody", equipable: true };
const helmet = { id: "melvorD:Dragon_Helmet", name: "Dragon Helmet", equipable: true };
const potion = { id: "melvorD:Potion", name: "Potion", equipable: false };

const MODS = ["Alpha", "Beta", "Gamma", "Delta"].map((name) => ({
  id: `enchanting:${name}`,
  name,
  quality: 1,
}));

const ENCHANT_ACTION = { id: "enchanting:Enchant", baseXP: 10, baseInterval: 10000 };
const DISENCHANT_ACTION = { id: "enchanting:Disenchant", baseXP: 5, baseInterval: 500 };
const REROLL_ACTION = { id: "enchanting:Reroll", baseXP: 0, baseInterval: -1 };

const registry = (objects) => ({
  allObjects: objects,
  get size() {
    return objects.length;
  },
  getObjectByID: (id) => objects.find((o) => o.id === id),
  registerObject: (o) => objects.push(o),
});

// Rolls are scripted where a test needs a particular one, and otherwise come from a seeded
// generator — NOT a constant. Handing back `min` every time would wedge the fake's own "roll
// until you have N distinct modifiers" loop, which is a real thing the mod does.
let rollScript = [];
let seed = 12345;
const nextRandom = (min, max) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return min + (seed % (max - min + 1));
};
globalThis.rollInteger = (min, max) => (rollScript.length ? rollScript.shift() : nextRandom(min, max));
globalThis.selectFromWeightedArray = (weights) => weights[0];

let bankFull = false;

const bank = {
  items: new Map(), // item -> qty
  lockedItems: new Set(),
  getQty: (item) => bank.items.get(item) ?? 0,
  addItem(item, qty) {
    if (bankFull) return false;
    bank.items.set(item, (bank.items.get(item) ?? 0) + qty);
    return true;
  },
  removeItemQuantity(item, qty) {
    const left = (bank.items.get(item) ?? 0) - qty;
    if (left > 0) bank.items.set(item, left);
    else bank.items.delete(item);
  },
  // Melvor hands the predicate a BankItem. What it returns is the plain Item — but a
  // bank-entry record has been reported coming back instead, so the mod has to cope with
  // either. Flip this to exercise the other shape.
  returnsBankItems: false,
  filterItems(pred) {
    const out = [];
    for (const [item, quantity] of bank.items) {
      if (pred({ item, quantity })) out.push(bank.returnsBankItems ? { item, quantity } : item);
    }
    return out;
  },
};

class FakeCosts {
  constructor() {
    this.entries = [];
  }
  addItem(item, quantity) {
    this.entries.push({ item, quantity });
  }
  setSource() {}
  getItemQuantityArray() {
    return this.entries;
  }
  checkIfOwned() {
    return this.entries.every(({ item, quantity }) => bank.getQty(item) >= quantity);
  }
  consumeCosts() {
    for (const { item, quantity } of this.entries) bank.removeItemQuantity(item, quantity);
  }
}

globalThis.Rewards = class {
  constructor() {
    this.items = [];
    this.xp = 0;
    this.skill = null;
  }
  setSource() {}
  addXP(skill, amount) {
    this.skill = skill;
    this.xp += amount;
  }
  addItem(item, quantity) {
    this.items.push({ item, quantity });
  }
  giveRewards() {
    if (bankFull) return true;
    if (this.skill) this.skill.xp += this.xp;
    for (const { item, quantity } of this.items) bank.addItem(item, quantity);
    return false;
  }
};

let itemCounter = 0;
let localizeCalls = 0;
let refuseStart = false; // stands in for the game's idleChecker turning us down

class FakeEnchanting {
  constructor() {
    this.id = "enchanting:Enchanting";
    this.level = 99;
    this.maxQuality = 5;
    this.xp = 0;
    this.isActive = false;
    this.selectedItem = undefined;
    this.selectedAction = undefined;
    this.renderQueue = { selectedItem: false, quantities: false };

    // What the player had set in the Enchanting mod before we took it over.
    this.autoDisenchantRewards = 3;
    this.autoDisenchantDrops = 2;
    this.includeCommonRewards = true;
    this.includeCommonDrops = false;
    this.downgradeRewards = false;
    this.downgradeDrops = false;

    this.menu = { autoDisenchantRow: mkEl("div"), localize: () => (localizeCalls += 1) };
    this.actions = registry([ENCHANT_ACTION, DISENCHANT_ACTION, REROLL_ACTION]);
    this.mods = registry([...MODS]);
    this.equipment = registry([]);

    this.dropWeights = [{ quality: 1, weight: 1 }];
    this.totalDropWeight = 1;
    this.rewardWeights = [{ quality: 1, weight: 1 }];
    this.totalRewardWeight = 1;
  }

  get currentAction() {
    return this.selectedAction ?? ENCHANT_ACTION;
  }

  isAugmentedItem(item) {
    return item !== undefined && item.item !== undefined;
  }
  canAugmentItem(item) {
    return item !== undefined && item.item === undefined && item.equipable === true;
  }
  getItemLevelMultiplier() {
    return 2; // not 1, so a test can tell whether the multiplier was applied at all
  }
  modifyXP(xp) {
    return xp;
  }
  isCostEmpty(costs) {
    return costs.entries.length === 0;
  }
  queueBankQuantityRender() {}

  modCount(base, quality) {
    return [0, 1, 2, 2, 3, 4][quality];
  }
  getPossibleMods(base, quality) {
    return this.mods.allObjects.filter((mod) => mod.quality <= quality);
  }

  createEnchantingItem(base, quality, mods = new Set(), specials = new Set()) {
    const rolled = new Set(mods);
    const pool = this.getPossibleMods(base, quality);
    while (rolled.size < this.modCount(base, quality)) {
      rolled.add(pool[globalThis.rollInteger(0, pool.length - 1)]);
    }
    const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
    const existing = this.equipment.allObjects.find(
      (e) => e.item === base && e.quality === quality && same(rolled, e.extraModifiers),
    );
    if (existing) return existing;

    itemCounter += 1;
    const item = {
      id: `enchanting:e${itemCounter}`,
      name: `${QUALITIES[quality]} ${base.name}`,
      item: base,
      quality,
      extraModifiers: rolled,
      extraSpecials: new Set(specials),
    };
    this.equipment.registerObject(item);
    return item;
  }

  getEssenceForItem(item, quality, quantity = 1) {
    return [ESSENCE[quality], this.getItemLevelMultiplier(item) * quantity];
  }

  getEnchantCosts(item) {
    const costs = new FakeCosts();
    if (item !== undefined && (item.item === undefined || item.quality < 5)) {
      costs.addItem(item, 1);
      if (item.item !== undefined) {
        costs.addItem(ESSENCE[item.quality], 10);
        costs.addItem(ESSENCE[item.quality + 1], 5);
      } else {
        costs.addItem(ESSENCE[0], 50);
        costs.addItem(ESSENCE[1], 25);
      }
    }
    return costs;
  }

  getRerollCosts(item) {
    const costs = new FakeCosts();
    if (item !== undefined && item.item !== undefined) costs.addItem(ESSENCE[item.quality], 5);
    return costs;
  }

  getCurrentActionCosts() {
    if (this.currentAction === DISENCHANT_ACTION) {
      const costs = new FakeCosts();
      if (this.selectedItem !== undefined) costs.addItem(this.selectedItem, 1);
      return costs;
    }
    if (this.currentAction === REROLL_ACTION) return this.getRerollCosts(this.selectedItem);
    return this.getEnchantCosts(this.selectedItem);
  }

  // XP off this.currentAction.baseXP, quirk and all — that is what the real mod does.
  giveAutoDisenchantRewards(item, quality) {
    this.xp += (this.currentAction.baseXP * (quality + 1) * this.getItemLevelMultiplier(item)) / 2;
  }

  replaceRewards(item, quantity) {
    return [item, quantity]; // stand-in; the mod under test replaces this outright
  }
  replaceDrop(item, quantity) {
    return { item, quantity };
  }

  selectActionOnClick(action) {
    if (this.isActive) this.stop();
    this.selectedAction = action;
  }
  selectItemOnClick(item) {
    if (this.isActive) this.stop();
    this.selectedItem = item;
  }

  // The real start() defers to the game's idleChecker: with stop-confirmations off it simply
  // takes the action slot from whatever held it, and with them on it refuses and puts a prompt
  // on screen. Both are the game's call, so both are modelled here.
  start() {
    if (refuseStart) return false;
    this.isActive = true;
    globalThis.game.activeAction = this;
    return true;
  }
  stop() {
    this.isActive = false;
    globalThis.game.activeAction = undefined;
    return true;
  }

  // One completed action: give the reward, consume the cost, then start again on the same
  // item — exactly what the real one does, and the reason an enchant has to be interrupted.
  action() {
    const costs = this.getCurrentActionCosts();
    if (!costs.checkIfOwned() || this.isCostEmpty(costs)) {
      this.stop();
      return;
    }

    if (this.currentAction === ENCHANT_ACTION) {
      const made = this.isAugmentedItem(this.selectedItem)
        ? this.createEnchantingItem(
            this.selectedItem.item,
            Math.min(this.selectedItem.quality + 1, 5),
            this.selectedItem.extraModifiers,
            this.selectedItem.extraSpecials,
          )
        : this.createEnchantingItem(this.selectedItem, 1);
      bank.addItem(made, 1);
      this.xp += ENCHANT_ACTION.baseXP;

      // The real mod keeps building things after it hands you the item — its bank upgrade
      // chain — so "the last item createEnchantingItem returned" is NOT a reliable pointer to
      // what the enchant produced. Reproduce that here: anything relying on it must break.
      this.createEnchantingItem(helmet, 1);
    } else if (this.currentAction === DISENCHANT_ACTION) {
      const quality = this.selectedItem.item !== undefined ? this.selectedItem.quality : 0;
      const [essence, qty] = this.getEssenceForItem(this.selectedItem, quality);
      bank.addItem(essence, qty);
      this.xp += DISENCHANT_ACTION.baseXP * (quality + 1) * this.getItemLevelMultiplier(this.selectedItem);
    }

    costs.consumeCosts();

    const next = this.getCurrentActionCosts();
    if (!next.checkIfOwned() || this.isCostEmpty(next)) this.stop();
    else this.start();
  }
}

const enchanting = new FakeEnchanting();
let saveCount = 0;
globalThis.game = {
  enchanting,
  bank,
  activeAction: undefined,
  scheduleSave: () => (saveCount += 1),
};

// ---- fake mod ctx ---------------------------------------------------------

const store = new Map();
let charLoaded;
let ifaceReady;
const ctx = {
  settings: { section: () => ({ add() {}, set() {} }) },
  characterStorage: { getItem: (k) => store.get(k), setItem: (k, v) => store.set(k, v) },
  onCharacterLoaded: (f) => (charLoaded = f),
  onInterfaceReady: (f) => (ifaceReady = f),
};

const { setup } = await import("../mod/setup.mjs");
setup(ctx);
charLoaded();
ifaceReady();

const api = globalThis.autoEnchanting;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// The mod's driver re-decides every 200ms; a beat longer than that is one job step.
const step = () => settle(240);
// The game's side of a timed action: the skill ticks its action through to completion.
const runAction = async () => {
  if (enchanting.isActive) enchanting.action();
  await step();
};

const lootSection = sectionByTitle("Auto-disenchant new loot");
const sweepSection = sectionByTitle("Disenchant the bank");
const queueSection = sectionByTitle("Task queue");

const sweepButton = buttonsIn(sweepSection)[0];
const queueButtons = buttonsIn(queueSection);
const addEnchantButton = queueButtons.filter((b) => b.textContent === "Add")[0];
const addRerollButton = queueButtons.filter((b) => b.textContent === "Add")[1];
const startQueueButton = queueButtons.find((b) => b.textContent === "Start queue");
const clearButton = queueButtons.find((b) => b.textContent === "Clear finished");

const enchantItemSelect = controlIn(queueSection, "Enchant");
const enchantGradeSelect = controlIn(queueSection, "Up to");
const rerollItemSelect = controlIn(queueSection, "Reroll");
const rerollModsSelect = controlIn(queueSection, "Until it has");

check("the panel mounts under the skill header", container.children.length === 1);
check("every section is built", !!lootSection && !!sweepSection && !!queueSection);
check(
  "every control is reachable",
  !!sweepButton && !!addEnchantButton && !!addRerollButton && !!startQueueButton && !!clearButton &&
    !!enchantItemSelect && !!enchantGradeSelect && !!rerollItemSelect && !!rerollModsSelect,
);

// ===========================================================================
// 1. Off by default.
// ===========================================================================
check("automation is off by default", api.settings.enabled === false);
check(
  "the Enchanting mod's own auto-disenchant is untouched while we're off",
  enchanting.autoDisenchantRewards === 3 && enchanting.autoDisenchantDrops === 2,
  `rewards=${enchanting.autoDisenchantRewards} drops=${enchanting.autoDisenchantDrops}`,
);
check(
  "its dropdowns are still visible while we're off",
  !enchanting.menu.autoDisenchantRow.classList.contains("auto-enchanting-hidden"),
);

// ===========================================================================
// 2. Taking the auto-disenchant over, and handing it back.
// ===========================================================================
const master = walk(container).find((node) => node.tag === "input" && node.type === "checkbox");
const enable = (on) => {
  master.checked = on;
  master.fire("change");
};

enable(true);
check(
  "enabling forces the mod's auto-disenchant off",
  enchanting.autoDisenchantRewards === -1 && enchanting.autoDisenchantDrops === -1,
  `rewards=${enchanting.autoDisenchantRewards} drops=${enchanting.autoDisenchantDrops}`,
);
check(
  "what it was set to is remembered",
  api.settings.nativeBackup?.autoDisenchantRewards === 3 && api.settings.nativeBackup?.autoDisenchantDrops === 2,
  JSON.stringify(api.settings.nativeBackup),
);
check("its dropdowns are hidden", enchanting.menu.autoDisenchantRow.classList.contains("auto-enchanting-hidden"));
check("its menu is re-localized so the dropdowns read None", localizeCalls > 0);

enable(false);
check(
  "disabling hands the settings back",
  enchanting.autoDisenchantRewards === 3 &&
    enchanting.autoDisenchantDrops === 2 &&
    enchanting.includeCommonRewards === true,
  `rewards=${enchanting.autoDisenchantRewards} drops=${enchanting.autoDisenchantDrops}`,
);
check("the backup is cleared once handed back", api.settings.nativeBackup === null);
check(
  "its dropdowns come back",
  !enchanting.menu.autoDisenchantRow.classList.contains("auto-enchanting-hidden"),
);

enable(true);

// ===========================================================================
// 3. The loot path, now ours.
// ===========================================================================
enchanting.dropWeights = [{ quality: 2, weight: 1 }]; // every drop rolls Rare
api.settings.autoDisenchantDrops = 2; // disenchant Rare and below
api.save();

let drop = enchanting.replaceDrop(platebody, 1);
check(
  "a Rare drop at grade Rare comes back as Rare essence",
  drop.item === ESSENCE[2] && drop.quantity === 2,
  `${drop.item?.id} x${drop.quantity}`,
);

api.settings.autoDisenchantDrops = 1; // only Uncommon and below
api.save();
drop = enchanting.replaceDrop(platebody, 1);
check(
  "a Rare drop above the grade is kept as an enchanted item",
  enchanting.isAugmentedItem(drop.item) && drop.item.quality === 2,
  `${drop.item?.id} q=${drop.item?.quality}`,
);

enchanting.rewardWeights = [{ quality: 0, weight: 1 }];
api.settings.autoDisenchantRewards = 1;
api.settings.includeCommonRewards = false;
api.save();
let reward = enchanting.replaceRewards(helmet, 3);
check("a Common reward is left alone by default", reward[0] === helmet && reward[1] === 3);

api.settings.includeCommonRewards = true;
api.save();
reward = enchanting.replaceRewards(helmet, 3);
check(
  "with Include Common on, it becomes Common essence",
  reward[0] === ESSENCE[0] && reward[1] === 6,
  `${reward[0]?.id} x${reward[1]}`,
);

api.settings.autoDisenchantRewards = -1;
api.settings.autoDisenchantDrops = -1;
api.settings.includeCommonRewards = false;
api.save();

// ===========================================================================
// 4. Disenchanting the bank — instant mode.
// ===========================================================================
bank.items.clear();
enchanting.equipment.allObjects.length = 0;

const uncommonPlate = enchanting.createEnchantingItem(platebody, 1, new Set([MODS[0]]));
const rarePlate = enchanting.createEnchantingItem(platebody, 2, new Set([MODS[0], MODS[1]]));
const lockedHelm = enchanting.createEnchantingItem(helmet, 1, new Set([MODS[2]]));
bank.items.set(uncommonPlate, 2);
bank.items.set(rarePlate, 1);
bank.items.set(lockedHelm, 5);
bank.items.set(potion, 10);
bank.lockedItems.add(lockedHelm);

api.settings.bankDisenchantGrade = 2; // Rare and below
api.settings.bankDisenchantMode = "instant";
api.save();

const xpBefore = enchanting.xp;
sweepButton.fire("click");
await step();

check("instant disenchant leaves locked items alone", bank.getQty(lockedHelm) === 5, `qty=${bank.getQty(lockedHelm)}`);
check("instant disenchant leaves items it can't enchant alone", bank.getQty(potion) === 10);
check(
  "instant disenchant empties the matching stacks",
  bank.getQty(uncommonPlate) === 0 && bank.getQty(rarePlate) === 0,
);
check(
  "each stack becomes the essence of its own grade, times the level multiplier",
  bank.getQty(ESSENCE[1]) === 4 && bank.getQty(ESSENCE[2]) === 2,
  `uncommon=${bank.getQty(ESSENCE[1])} rare=${bank.getQty(ESSENCE[2])}`,
);
// 2 Uncommon: 5 * 2 * 2 / 2 = 10.  1 Rare: 5 * 3 * 2 / 2 = 15.
check("it pays half the XP a manual disenchant would", enchanting.xp - xpBefore === 25, `xp=${enchanting.xp - xpBefore}`);
check("the job ends by itself", api.job === null);

// ===========================================================================
// 5. Disenchanting the bank — using the skill.
// ===========================================================================
bank.items.clear();
bank.lockedItems.clear();
const plateA = enchanting.createEnchantingItem(platebody, 1, new Set([MODS[0]]));
bank.items.set(plateA, 3);

api.settings.bankDisenchantMode = "skill";
api.settings.bankDisenchantGrade = 2;
api.save();

// Starting a disenchant while you're doing something else is the GAME's call, made by its own
// idleChecker — exactly as if you'd clicked the button yourself. We don't second-guess it.
const otherSkill = { name: "Woodcutting" };
globalThis.game.activeAction = otherSkill;
refuseStart = true; // the game says no (its "stop what you're doing?" prompt is up)
sweepButton.fire("click");
await step();
check(
  "if the game refuses to start, the job stops cleanly",
  api.job === null && globalThis.game.activeAction === otherSkill && !enchanting.isActive,
);

refuseStart = false; // the game says yes, and takes the slot from whatever held it
sweepButton.fire("click");
await step();
check(
  "if the game allows it, the disenchant takes the action slot",
  globalThis.game.activeAction === enchanting,
);
check("with the slot free it starts the skill on the right item", enchanting.isActive && enchanting.selectedItem === plateA);
check("and on the Disenchant action", enchanting.selectedAction === DISENCHANT_ACTION);

await runAction();
await runAction();
await runAction();
check("the skill drains the whole stack", bank.getQty(plateA) === 0, `qty=${bank.getQty(plateA)}`);
check("full-price essence lands in the bank", bank.getQty(ESSENCE[1]) === 6, `qty=${bank.getQty(ESSENCE[1])}`);
check("the job finishes and releases the action slot", api.job === null && globalThis.game.activeAction === undefined);

// ===========================================================================
// 6. The queue: enchant a single item up to a grade.
//
// The stack is deliberately 3 deep: the skill's own action() would happily push all three to
// Uncommon, and the whole point is that a task walks ONE item up to its target instead.
// ===========================================================================
bank.items.clear();
enchanting.equipment.allObjects.length = 0;
bank.items.set(platebody, 3);
for (const essence of ESSENCE) bank.items.set(essence, 500);

api.settings.essenceFloor = 0;
api.save();

enchantItemSelect.value = platebody.id;
enchantGradeSelect.value = "3"; // Epic
addEnchantButton.fire("click");

check("the task lands in the queue", api.settings.queue.length === 1 && api.settings.queue[0].kind === "enchant");
check("it remembers the goal", api.settings.queue[0].target === 3 && api.settings.queue[0].status === "pending");

startQueueButton.fire("click");
await step();
for (let i = 0; i < 6 && api.job; i += 1) await runAction();

const epic = enchanting.equipment.allObjects.find((item) => item.quality === 3);
check("one item is walked all the way up to the target grade", bank.getQty(epic) === 1, `epic=${bank.getQty(epic)}`);
check("the rest of the stack is left alone", bank.getQty(platebody) === 2, `plain=${bank.getQty(platebody)}`);
check(
  "nothing is left stranded at the grades in between",
  bank.getQty(enchanting.equipment.allObjects.find((i) => i.quality === 1 && i.item === platebody)) === 0,
);
check("the task is marked done", api.settings.queue[0].status === "done", api.settings.queue[0].status);
check("the queue stops once it's empty of work", api.job === null && !enchanting.isActive);

// Duplicates. The mod reuses an identical roll rather than making a second copy of it, so the
// item an enchant "creates" is very often one you already own — the stack just goes from 2 to 3.
// Several of your items can also share a base, a grade and a name while being different objects.
// Counting which stack grew is the only thing that tells them apart.
clearButton.fire("click");
bank.items.clear();
enchanting.equipment.allObjects.length = 0;

const twin = enchanting.createEnchantingItem(platebody, 1, new Set([MODS[0]]));
bank.items.set(twin, 2); // you already own two of exactly what the enchant is about to make
bank.items.set(platebody, 1);
for (const essence of ESSENCE) bank.items.set(essence, 500);

enchantItemSelect.value = platebody.id;
enchantGradeSelect.value = "2"; // Rare
addEnchantButton.fire("click");
const dupTask = api.settings.queue[0];

rollScript = [0]; // the plain item rolls Alpha, i.e. exactly the twin you already have
startQueueButton.fire("click");
await step();
await runAction();

check(
  "an enchant that lands in a stack you already own is still found",
  dupTask.itemID === twin.id && bank.getQty(twin) === 3,
  `itemID=${dupTask.itemID} twins=${bank.getQty(twin)}`,
);

for (let i = 0; i < 5 && api.job; i += 1) await runAction();
check("and the task runs to its target from there", dupTask.status === "done", `${dupTask.status} — ${dupTask.note}`);

// Stopping and restarting mid-task must resume, not fail.
//
// Each enchant replaces the item with a new object and a new id. If the task kept naming the
// item it started from, Start would go looking for something that had already been consumed.
clearButton.fire("click");
bank.items.clear();
enchanting.equipment.allObjects.length = 0;
bank.items.set(platebody, 1);
for (const essence of ESSENCE) bank.items.set(essence, 500);

enchantItemSelect.value = platebody.id;
enchantGradeSelect.value = "3"; // Epic
addEnchantButton.fire("click");
const resumed = api.settings.queue[0];
check("the task starts out naming the plain item", resumed.itemID === platebody.id);

startQueueButton.fire("click");
await step();
await runAction(); // one grade up: the item is now a different object
startQueueButton.fire("click"); // Stop

check("stopping puts the task back to pending", resumed.status === "pending", resumed.status);
check(
  "and the task now names the item it actually holds",
  resumed.itemID !== platebody.id && resumed.itemID === enchanting.equipment.allObjects.find((i) => i.quality === 1)?.id,
  `itemID=${resumed.itemID}`,
);
check("which is what the row shows", resumed.itemName === "Uncommon Dragon Platebody", resumed.itemName);

startQueueButton.fire("click"); // Start again
await step();
for (let i = 0; i < 6 && api.job; i += 1) await runAction();

check("restarting resumes instead of failing", resumed.status === "done", `${resumed.status} — ${resumed.note}`);
check(
  "and it still reaches the target",
  bank.getQty(enchanting.equipment.allObjects.find((i) => i.quality === 3)) === 1,
);

// The essence floor is a hard stop, not a suggestion.
clearButton.fire("click");
bank.items.clear();
bank.items.set(platebody, 3);
bank.items.set(ESSENCE[0], 60); // an enchant off a plain item costs 50 Common x2 = 100
api.settings.essenceFloor = 40;
api.save();

enchantItemSelect.value = platebody.id;
enchantGradeSelect.value = "1";
addEnchantButton.fire("click");
startQueueButton.fire("click");
await step();

check("it refuses to spend past the essence floor", bank.getQty(ESSENCE[0]) === 60, `common=${bank.getQty(ESSENCE[0])}`);
check("and says why", api.settings.queue[0]?.status === "failed", api.settings.queue[0]?.note);

// ===========================================================================
// 7. The queue: reroll until the modifiers you want.
// ===========================================================================
clearButton.fire("click");
bank.items.clear();
enchanting.equipment.allObjects.length = 0;
api.settings.essenceFloor = 0;
api.settings.rerollMax = 50;
api.save();

// A grade-2 item has two modifier slots; give it two we don't want.
rollScript = [];
const rerollMe = enchanting.createEnchantingItem(platebody, 2, new Set([MODS[0], MODS[1]]));
bank.items.set(rerollMe, 1);
bank.items.set(ESSENCE[2], 100);

rerollItemSelect.value = rerollMe.id;
rerollItemSelect.fire("change"); // the mod fills the modifier list from the item you picked
check("the modifier list offers what the item can roll", rerollModsSelect.children.length === MODS.length);

rerollModsSelect.selectedOptions = rerollModsSelect.children.filter((o) => o.value === MODS[2].id);
addRerollButton.fire("click");
check("the reroll task lands in the queue", api.settings.queue.length === 1 && api.settings.queue[0].kind === "reroll");

// The Alpha slot rolls Alpha again, then Delta, then Gamma — the one we asked for.
// (Its pool excludes Beta, which the item already holds: [Alpha, Gamma, Delta].)
rollScript = [0, 2, 1];
startQueueButton.fire("click");
await step();

const held = [...bank.items.keys()].find((item) => enchanting.isAugmentedItem(item));
check("rerolling stops as soon as the modifier shows up", api.job === null);
check("the item has it", held?.extraModifiers.has(MODS[2]) === true, [...(held?.extraModifiers ?? [])].map((m) => m.name).join("+"));
check("the modifier you didn't ask about is left alone", held?.extraModifiers.has(MODS[1]) === true);
check("the old item is gone", bank.getQty(rerollMe) === 0);
check("three rerolls were paid for", bank.getQty(ESSENCE[2]) === 85, `essence=${bank.getQty(ESSENCE[2])}`);
check("the task is marked done", api.settings.queue[0].status === "done", api.settings.queue[0].note);

// Asking for more modifiers than the item can hold is refused at Add, not after 500 rerolls.
clearButton.fire("click");
rerollItemSelect.value = held.id;
rerollItemSelect.fire("change");
rerollModsSelect.selectedOptions = rerollModsSelect.children.filter((o) =>
  [MODS[0].id, MODS[1].id, MODS[2].id].includes(o.value),
);
addRerollButton.fire("click");
check("asking for more modifiers than the item has slots is refused", api.settings.queue.length === 0);

// ===========================================================================
// 8. The bank handing back records instead of items.
//
// filterItems() is documented (by the Enchanting mod's own use of it) to return plain Items,
// but bank-entry records have been reported coming back instead — and the two are easy to
// confuse, since an enchanted item also has an `.item`. Neither shape may break a sweep.
// ===========================================================================
bank.returnsBankItems = true;
clearButton.fire("click");
bank.items.clear();
enchanting.equipment.allObjects.length = 0;

const recordPlate = enchanting.createEnchantingItem(platebody, 1, new Set([MODS[0]]));
bank.items.set(recordPlate, 2);
api.settings.bankDisenchantGrade = 1;
api.settings.bankDisenchantMode = "instant";
api.save();

sweepButton.fire("click");
await step();
check(
  "a sweep works even when the bank returns records, not items",
  bank.getQty(recordPlate) === 0 && bank.getQty(ESSENCE[1]) === 4,
  `plate=${bank.getQty(recordPlate)} essence=${bank.getQty(ESSENCE[1])}`,
);

bank.returnsBankItems = false;

// ===========================================================================
// 9. Persistence across a game restart.
//
// characterStorage only reaches the save file when the game next saves, so saveSettings()
// must also ask the game to save — otherwise a toggle followed by a reload is lost.
// ===========================================================================
store.delete("settings");
saveCount = 0;
api.settings.bankDisenchantGrade = 4;
api.save();

check("saving a setting schedules a game save", saveCount > 0, `saves=${saveCount}`);
const storedNow = store.get("settings");
check("settings were actually written to characterStorage", !!storedNow);
check("the stored value round-trips as a plain object", typeof storedNow === "object");
check("the stored value holds what we set", storedNow?.bankDisenchantGrade === 4, `grade=${storedNow?.bankDisenchantGrade}`);

const fresh = await import("../mod/setup.mjs?restart=1");
let freshChar;
let freshIface;
fresh.setup({
  settings: { section: () => ({ add() {}, set() {} }) },
  characterStorage: ctx.characterStorage,
  onCharacterLoaded: (f) => (freshChar = f),
  onInterfaceReady: (f) => (freshIface = f),
});
freshChar();
freshIface();
check(
  "a restarted mod reads its settings back",
  globalThis.autoEnchanting.settings.enabled === true &&
    globalThis.autoEnchanting.settings.bankDisenchantGrade === 4,
  `enabled=${globalThis.autoEnchanting.settings.enabled} grade=${globalThis.autoEnchanting.settings.bankDisenchantGrade}`,
);

// A storage layer that hands back JSON instead of an object must not silently degrade to
// defaults (spreading a string yields numeric keys and every real setting stays default).
store.set("settings", JSON.stringify({ ...storedNow, bankDisenchantGrade: 5 }));
const fresh2 = await import("../mod/setup.mjs?restart=2");
let f2Char;
let f2Iface;
fresh2.setup({
  settings: { section: () => ({ add() {}, set() {} }) },
  characterStorage: ctx.characterStorage,
  onCharacterLoaded: (f) => (f2Char = f),
  onInterfaceReady: (f) => (f2Iface = f),
});
f2Char();
f2Iface();
check(
  "a JSON-string payload is parsed, not spread into garbage",
  globalThis.autoEnchanting.settings.bankDisenchantGrade === 5 &&
    globalThis.autoEnchanting.settings.enabled === true,
  `grade=${globalThis.autoEnchanting.settings.bankDisenchantGrade}`,
);

// ===========================================================================
console.log("");
let failed = 0;
for (const { name, pass, extra } of results) {
  if (pass) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${extra ? `  [${extra}]` : ""}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
