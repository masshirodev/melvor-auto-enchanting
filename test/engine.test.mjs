// node test/engine.test.mjs
//
// Drives the real mod/setup.mjs against a fake Melvor + fake Enchanting mod. The fakes are
// deliberately faithful where it matters: the skill's action() self-restarts on the same item
// (which is what forces the mod to interrupt an enchant), createEnchantingItem() returns a
// brand-new item object each grade, costs are checked against a real bank, and the loot path
// rolls a quality before deciding what to do with it.

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
  querySelector(sel) {
    return sel === ".skill-info" ? skillInfo : null;
  },
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

const walk = (el, out = []) => {
  for (const child of el.children ?? []) {
    out.push(child);
    walk(child, out);
  }
  return out;
};
// Each panel section is a div holding an <h4> caption; find it by that caption, then reach
// for the control inside it. Keeps the test readable and independent of element order.
const rowByHeading = (heading) =>
  walk(container).find((el) => (el.children ?? []).some((c) => c.tag === "h4" && c.textContent === heading));
const buttonIn = (row) => walk(row).find((el) => el.tag === "button");
const controlIn = (row, labelText) =>
  walk(row).find((el) => el.tag === "label" && (el.children[0]?.textContent ?? "").startsWith(labelText))
    ?.children[1];
const optionTexts = (select) => (select?.children ?? []).map((option) => option.textContent);

// ---- fake game ------------------------------------------------------------

const QUALITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];
const ESSENCE = QUALITIES.map((q) => ({ id: `enchanting:${q}_Essence`, name: `${q} Essence` }));

const platebody = { id: "melvorD:Dragon_Platebody", name: "Dragon Platebody", equipable: true };
const helmet = { id: "melvorD:Dragon_Helmet", name: "Dragon Helmet", equipable: true };
const potion = { id: "melvorD:Potion", name: "Potion", equipable: false };

const MODS = ["Alpha", "Beta", "increasedGlobalAccurate", "Delta"].map((name) => ({
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

// Rolls are scripted so the reroll tests are deterministic.
let rollScript = [];
let fallbackRoll = 0;
globalThis.rollInteger = (min, max = min) => {
  if (rollScript.length) return rollScript.shift();
  const span = max - min + 1;
  const rolled = min + (fallbackRoll % span);
  fallbackRoll += 1;
  return rolled;
};
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
  filterItems(pred) {
    const out = [];
    for (const [item, quantity] of bank.items) {
      const bankItem = { item, quantity };
      if (pred(bankItem)) out.push(bankItem);
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

  start() {
    if (globalThis.game.activeAction !== undefined && globalThis.game.activeAction !== this) return false;
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
const characterStorage = { getItem: (k) => store.get(k), setItem: (k, v) => store.set(k, v) };
const settingStore = new Map();
const settingSection = {
  add(config) {
    if (!settingStore.has(config.name)) settingStore.set(config.name, config.default);
  },
  get: (name) => settingStore.get(name),
  set: (name, value) => settingStore.set(name, value),
};
let charLoaded;
let ifaceReady;
const ctx = {
  settings: { section: () => settingSection },
  onCharacterLoaded: (f) => (charLoaded = f),
  onInterfaceReady: (f) => (ifaceReady = f),
};
const loadedCtx = { ...ctx, characterStorage };

const { setup } = await import("../mod/setup.mjs");
setup(ctx);
charLoaded(loadedCtx);
ifaceReady(loadedCtx);

const api = globalThis.autoEnchanting;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// The mod's driver re-decides every 200ms; a beat longer than that is one job step.
const step = () => settle(240);
const pickItem = async (row, labelText, item) => {
  // Let the panel's timed refresh rebuild the bank-backed dropdown after the test mutates bank.
  await settle(1050);
  const select = controlIn(row, labelText);
  const entry = [...(select.__items ?? new Map())].find(([, value]) => value === item);
  select.value = entry?.[0] ?? item.id;
  select.fire("change");
  return select;
};

// Runs the game's side of a timed action: the skill ticks its action to completion.
const runAction = async () => {
  if (enchanting.isActive) enchanting.action();
  await step();
};

const lootRow = rowByHeading("Auto-disenchant new loot");
const disenchantRow = rowByHeading("Disenchant the bank");
const enchantRow = rowByHeading("Enchant until");
const rerollRow = rowByHeading("Reroll until");

check("the panel is mounted under the skill header", container.children.length === 1);
check("every section of the panel is built", !!lootRow && !!disenchantRow && !!enchantRow && !!rerollRow);

// ===========================================================================
// 1. Off by default.
// ===========================================================================
check("automation is off by default", api.settings.enabled === false);
check(
  "the Enchanting mod's own auto-disenchant is untouched while we're off",
  enchanting.autoDisenchantRewards === 3 && enchanting.autoDisenchantDrops === 2,
  `rewards=${enchanting.autoDisenchantRewards} drops=${enchanting.autoDisenchantDrops}`,
);
check("its dropdowns are still visible while we're off", !enchanting.menu.autoDisenchantRow.classList.contains("auto-enchanting-hidden"));

// ===========================================================================
// 2. Taking the auto-disenchant over, and handing it back.
// ===========================================================================
const enable = (on) => {
  api.settings.enabled = on;
  api.save();
  // Same path the master checkbox takes.
  const master = walk(container).find((el) => el.tag === "input" && el.type === "checkbox");
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
check("its dropdowns come back", !enchanting.menu.autoDisenchantRow.classList.contains("auto-enchanting-hidden"));

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

// A plain (quality 0) roll is only touched when you ask for it.
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
const lockedPlate = enchanting.createEnchantingItem(helmet, 1, new Set([MODS[2]]));
bank.items.set(uncommonPlate, 2);
bank.items.set(rarePlate, 1);
bank.items.set(lockedPlate, 5);
bank.items.set(potion, 10);
bank.lockedItems.add(lockedPlate);

api.settings.bankDisenchantGrade = 2; // Rare and below
api.settings.bankDisenchantMode = "instant";
api.save();

const xpBefore = enchanting.xp;
buttonIn(disenchantRow).fire("click");
await step();

check("instant disenchant leaves locked items alone", bank.getQty(lockedPlate) === 5, `qty=${bank.getQty(lockedPlate)}`);
check("instant disenchant leaves items it can't enchant alone", bank.getQty(potion) === 10);
check("instant disenchant empties the matching stacks", bank.getQty(uncommonPlate) === 0 && bank.getQty(rarePlate) === 0);
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

const otherSkill = { name: "Woodcutting" };
globalThis.game.activeAction = otherSkill;
buttonIn(disenchantRow).fire("click");
await step();
check("it won't touch the skill while something else is using it", api.job === null && globalThis.game.activeAction === otherSkill);

globalThis.game.activeAction = undefined;
buttonIn(disenchantRow).fire("click");
await step();
check("with the slot free it starts the skill on the right item", enchanting.isActive && enchanting.selectedItem === plateA);
check("and on the Disenchant action", enchanting.selectedAction === DISENCHANT_ACTION);

// The skill's own loop drains the stack: three actions, one per item in it.
await runAction();
await runAction();
await runAction();
check("the skill drains the whole stack", bank.getQty(plateA) === 0, `qty=${bank.getQty(plateA)}`);
check("full-price essence lands in the bank", bank.getQty(ESSENCE[1]) === 6, `qty=${bank.getQty(ESSENCE[1])}`);
check("the job finishes and releases the action slot", api.job === null && globalThis.game.activeAction === undefined);

// ===========================================================================
// 6. Enchant until grade X.
//
// The stack is deliberately 3 deep: the skill's action() would happily push all three to
// Uncommon, and the point of the mod is that it walks ONE item up to the target instead.
// ===========================================================================
bank.items.clear();
enchanting.equipment.allObjects.length = 0;
bank.items.set(platebody, 3);
bank.items.set(ESSENCE[0], 500);
bank.items.set(ESSENCE[1], 500);
bank.items.set(ESSENCE[2], 500);
bank.items.set(ESSENCE[3], 500);

api.settings.enchantTarget = 3; // Epic
api.settings.enchantScope = "single";
api.settings.essenceFloor = 0;
api.save();

await pickItem(enchantRow, "Item:", platebody);
buttonIn(enchantRow).fire("click");
await step();

for (let i = 0; i < 6 && api.job; i += 1) await runAction();

const epic = enchanting.equipment.allObjects.find((item) => item.quality === 3);
check("one item is walked all the way up to the target grade", bank.getQty(epic) === 1, `epic=${bank.getQty(epic)}`);
check("the rest of the stack is left where it was", bank.getQty(platebody) === 2, `plain=${bank.getQty(platebody)}`);
check("nothing is left behind at the grades in between", bank.getQty(enchanting.equipment.allObjects.find((i) => i.quality === 1)) === 0);
check("the job stops at the target", api.job === null && !enchanting.isActive);

// The essence floor is a hard stop, not a suggestion.
bank.items.set(ESSENCE[0], 60);
api.settings.essenceFloor = 40; // an enchant off plain costs 50 Common x2 = 100
api.settings.enchantTarget = 1;
api.save();
await pickItem(enchantRow, "Item:", platebody);
buttonIn(enchantRow).fire("click");
await step();
check("it refuses to spend past the essence floor", api.job === null && bank.getQty(ESSENCE[0]) === 60, `common=${bank.getQty(ESSENCE[0])}`);

// ===========================================================================
// 7. Reroll until the modifiers you want.
// ===========================================================================
bank.items.clear();
enchanting.equipment.allObjects.length = 0;
api.settings.essenceFloor = 0;

// A grade-2 item has two modifier slots; give it two we don't want.
rollScript = [];
const rerollMe = enchanting.createEnchantingItem(platebody, 2, new Set([MODS[0], MODS[1]]));
bank.items.set(rerollMe, 1);
bank.items.set(ESSENCE[2], 100);

api.settings.rerollTargetModIDs = [MODS[2].id]; // we want Increased Global Accurate, and only that
api.settings.rerollMax = 50;
api.save();

// First reroll of the Alpha slot lands on Alpha again; the second lands on the target.
// The pool excludes Beta because the item already has it, so the target is index 1.
rollScript = [0, 1];
await pickItem(rerollRow, "Item:", rerollMe);
check(
  "modifier names are formatted for the UI",
  optionTexts(controlIn(rerollRow, "Modifiers you want:")).includes("Increased Global Accurate"),
);
buttonIn(rerollRow).fire("click");
await step();

const rerolled = enchanting.equipment.allObjects.find((item) => bank.getQty(item) === 1 && item.quality === 2);
check("rerolling stops as soon as the modifier you wanted shows up", api.job === null);
check("the item now has it", rerolled?.extraModifiers.has(MODS[2]) === true, [...(rerolled?.extraModifiers ?? [])].map((m) => m.name).join("+"));
check("the modifier you didn't ask about is left alone", rerolled?.extraModifiers.has(MODS[1]) === true);
check("the old item is gone from the bank", bank.getQty(rerollMe) === 0);
check("two rerolls were paid for", bank.getQty(ESSENCE[2]) === 90, `essence=${bank.getQty(ESSENCE[2])}`);

// Asking for more modifiers than the item can hold is refused up front, not after 500 rerolls.
api.settings.rerollTargetModIDs = [MODS[0].id, MODS[1].id, MODS[2].id];
api.save();
await pickItem(rerollRow, "Item:", rerolled);
buttonIn(rerollRow).fire("click");
await step();
check("asking for more modifiers than the item has slots is refused", api.job === null);

// ===========================================================================
// 8. Persistence across a game restart.
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
check("enabled is persisted by Mod Settings, not duplicated into characterStorage", storedNow?.enabled === undefined && settingStore.get("enabled") === true);

const fresh = await import("../mod/setup.mjs?restart=1");
let freshChar;
let freshIface;
fresh.setup({
  settings: ctx.settings,
  onCharacterLoaded: (f) => (freshChar = f),
  onInterfaceReady: (f) => (freshIface = f),
});
freshChar(loadedCtx);
freshIface(loadedCtx);
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
  settings: ctx.settings,
  onCharacterLoaded: (f) => (f2Char = f),
  onInterfaceReady: (f) => (f2Iface = f),
});
f2Char(loadedCtx);
f2Iface(loadedCtx);
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
