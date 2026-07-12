// Auto Enchanting
// Bulk operations for the Enchanting mod: disenchant your bank by grade, and queue up per-item
// jobs — enchant this one to Epic, reroll that one until it has the modifiers you want — then
// let it work through the list. Also takes over the Enchanting mod's auto-disenchant of new
// loot, so every option lives in one place.
//
// Hooks the real Enchanting structures (confirmed at runtime, see probes/probe1.js):
//   game.enchanting                     -> the Enchanting skill instance (class Enchanting extends Skill)
//   .actions                            -> NamespaceRegistry: enchanting:Enchant | Disenchant | Reroll
//   .equipment                          -> NamespaceRegistry of every enchanted item instance
//   .mods                               -> NamespaceRegistry<EnchantingMod>
//   .selectActionOnClick(a) / .selectItemOnClick(i) / .start() / .stop() / .isActive
//   .getCurrentActionCosts() / .isCostEmpty(costs) / .getEnchantCosts(i) / .getRerollCosts(i)
//   .getEssenceForItem(item, quality, qty) / .getItemLevelMultiplier(item)
//   .isAugmentedItem(i) / .canAugmentItem(i) / .createEnchantingItem(base, quality, mods, specials)
//   .getPossibleMods(base, quality) / .modCount(base, quality)
//   .replaceDrop(item, qty) / .replaceRewards(item, qty)   -> the on-loot auto-disenchant path
//   An enchanted item is a *new item instance*: .item is the base item, .quality is the grade
//   (0 Common .. 5 Mythic), .extraModifiers is a Set of EnchantingMod.
//   Locked items are vanilla: game.bank.lockedItems, a Set<Item>.
//
// Three things the Enchanting mod does NOT let us do, so we do them here:
//   * Enchant and Disenchant claim game.activeAction, and their action() loop re-runs on the
//     SAME selected item until its costs run out. Left alone, "enchant until Rare" on a stack
//     of five would just push all five to Uncommon. So we interrupt after every action (the
//     cost of an action is only consumed once it completes, so stopping a fresh one is free)
//     and re-decide what to select next.
//   * executeReroll() picks which modifier to reroll by reading a DOM radio button, so it is
//     unusable from code. rerollSlot() below reimplements it with an explicit slot.
//   * Its auto-disenchant is not a setting — it is six fields on the skill, saved inside the
//     Enchanting skill's own save blob. We snapshot them, force them off, and reimplement the
//     behaviour on our own settings (see the Loot takeover section).
//
// An enchant or a reroll replaces the item with a brand-new object, so a queued task follows
// the item it made rather than the id you picked. See onEnchantActionDone() and rerollSlot().

const VERSION = "0.1.2";
const TAG = `[Auto Enchanting v${VERSION}]`;
const MARK = "auto-enchanting";
const PATCH_FLAG = `__${MARK}_patched`;

const ENCHANT = "enchanting:Enchant";
const DISENCHANT = "enchanting:Disenchant";

// quality (aka grade) is a plain int on the item; 0 means "not enchanted".
const QUALITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];
const MAX_QUALITY = 5;
const OFF = -1;

const STORAGE_KEY = "settings";
// Melvor gives each mod 8kb of character storage. Going over does not throw — it just doesn't
// save — so we check before writing rather than wondering later.
const STORAGE_LIMIT = 8192;
const DRIVER_MS = 200; // how often a running job re-decides what to do next
const INSTANT_BATCH = 25; // instant disenchants per driver tick, so a big bank can't stall a frame
const REROLL_BATCH = 20; // rerolls per driver tick (each one is instant)

const DEFAULTS = {
  enabled: false,

  // Loot takeover — the Enchanting mod's own auto-disenchant, rehomed here.
  // -1 = off, otherwise "disenchant anything of this grade or below".
  autoDisenchantRewards: OFF,
  autoDisenchantDrops: OFF,
  includeCommonRewards: false,
  includeCommonDrops: false,
  downgradeRewards: false,
  downgradeDrops: false,
  // What those six fields were set to before we took them over, so we can put them back.
  nativeBackup: null,

  // Bank sweep.
  bankDisenchantGrade: OFF,
  bankDisenchantMode: "skill", // "skill" = full XP, uses the skill | "instant" = half XP, does not

  // The task queue: one entry per item you want enchanted or rerolled.
  // { id, kind: "enchant" | "reroll", itemID, itemName, target?, modIDs?, status, note }
  queue: [],

  // Limits that apply to every task in the queue. Both spend, so both are guarded.
  essenceFloor: 0, // never take an essence below this quantity
  rerollMax: 500, // give up on a reroll task after this many tries

  savedAt: 0, // stamped on every write; the only honest proof a write survived a reload
};

let settings = structuredClone(DEFAULTS);
let storage = null; // ctx.characterStorage
let settingsLoaded = false;
let lastStatus = "idle";

// The one job in flight, or null. Only one at a time: they all compete for either the skill's
// action slot or the item you picked.
let job = null;
let driver = null; // setInterval handle, alive only while a job is

// The item the Enchanting mod's createEnchantingItem() produced most recently. An enchant
// makes a brand-new item object rather than mutating the old one, and there is no other way
// to find out which one it made — a bank search for "same base, one grade up" could just as
// easily hand back an item you already owned and cared about.
let lastCreated = null;

// ---------------------------------------------------------------------------
// Globals
//
// Melvor's `game` and friends are lexically scoped inside its bundle, so they are NOT on
// globalThis. Reach them by bare name behind a typeof guard (same trick as auto-sailing),
// falling back to globalThis.
// ---------------------------------------------------------------------------

function getGame() {
  if (globalThis.game) return globalThis.game;
  if (typeof game !== "undefined" && game) return game;
  return undefined;
}

function getEnchanting() {
  return getGame()?.enchanting;
}

function getBank() {
  return getGame()?.bank;
}

function getRewardsClass() {
  if (typeof Rewards !== "undefined" && Rewards) return Rewards;
  return globalThis.Rewards;
}

function getRollInteger() {
  if (typeof rollInteger !== "undefined" && rollInteger) return rollInteger;
  return globalThis.rollInteger;
}

function getSelectFromWeightedArray() {
  if (typeof selectFromWeightedArray !== "undefined" && selectFromWeightedArray) {
    return selectFromWeightedArray;
  }
  return globalThis.selectFromWeightedArray;
}

const log = (...args) => console.log(TAG, ...args);
const warn = (...args) => console.warn(TAG, ...args);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
  if (!storage) {
    warn("no characterStorage; settings will not persist this session");
    return;
  }
  try {
    let saved = storage.getItem(STORAGE_KEY);
    // Tolerate a JSON string as well as an object — spreading a string would otherwise
    // silently produce a garbage object with numeric keys and leave every real setting
    // sitting at its default, which looks exactly like "settings didn't save".
    if (typeof saved === "string") saved = JSON.parse(saved);
    if (!saved || typeof saved !== "object") {
      log("no saved settings for this character; using defaults");
      settingsLoaded = true;
      return;
    }
    settings = { ...structuredClone(DEFAULTS), ...saved, queue: saved.queue ?? [] };
    // Nothing is running yet, whatever the save says.
    for (const task of settings.queue) if (task.status === "running") task.status = "pending";
    settingsLoaded = true;

    // The one thing that actually proves persistence works: settings we wrote in an earlier
    // session came back. A canary round-trip can't tell you this — the store can work in memory
    // and still be dropped when the character save is written, which is exactly what happens to
    // a local mod that isn't linked to mod.io.
    const age = settings.savedAt ? Math.round((Date.now() - settings.savedAt) / 1000) : null;
    log(age === null ? "settings loaded" : `settings loaded (saved ${age}s ago)`, settings);
  } catch (err) {
    warn("could not load settings, using defaults", err);
  }
}

function saveSettings() {
  if (!storage) {
    warn("cannot save settings: no characterStorage (is a character loaded?)");
    return;
  }
  try {
    // Stamped so the next load can prove the write survived. See loadSettings().
    settings.savedAt = Date.now();

    // Round-trip through JSON so we can never hand characterStorage something
    // unserialisable, and so what we store is exactly what we'll read back.
    const payload = JSON.parse(JSON.stringify(settings));

    const size = JSON.stringify(payload).length;
    if (size > STORAGE_LIMIT) {
      warn(
        `settings are ${size} bytes, over Melvor's ${STORAGE_LIMIT}-byte limit for a mod's character storage — ` +
          "they will not be saved. Clear some finished tasks from the queue.",
      );
      return;
    }

    storage.setItem(STORAGE_KEY, payload);

    // characterStorage is only written into the save file when the game next saves. Without
    // this, changing a setting and then reloading (or closing the tab) before the next
    // autosave loses it — which is the whole "my settings don't persist" symptom.
    getGame()?.scheduleSave?.();
  } catch (err) {
    warn("could not save settings", err);
  }
}

// Melvor's wiki, on both Mod Settings and character storage:
//
//   "When loading your mod as a Local Mod via the Creator Toolkit, the mod must be linked to
//    mod.io and you must have subscribed to and installed the mod via mod.io in order for this
//    data to persist."
//
// So a local mod that isn't linked to mod.io silently saves nothing, which looks exactly like a
// bug in here. Round-trip a canary and say so plainly instead of leaving you to guess.
function checkStorage() {
  if (!storage?.setItem) {
    warn("characterStorage is unavailable — settings cannot be saved this session.");
    return false;
  }
  try {
    const canary = `canary-${Date.now()}`;
    storage.setItem("storage-check", canary);
    const readBack = storage.getItem("storage-check");
    storage.removeItem?.("storage-check");

    if (readBack !== canary) {
      warn(
        "characterStorage did not read back what we wrote — settings will not persist. " +
          "If this is a local mod, Melvor requires it to be linked to mod.io and installed from " +
          "there before any mod data is saved.",
      );
      return false;
    }
    return true;
  } catch (err) {
    warn("characterStorage threw; settings will not persist", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function qualityOf(item) {
  return item?.quality ?? 0;
}

function qualityName(quality) {
  return quality < 0 ? "Off" : (QUALITIES[quality] ?? String(quality));
}

function isLocked(item) {
  return Boolean(getBank()?.lockedItems?.has(item));
}

// The costs of an enchant include the item itself; only the essences are worth guarding.
function isEssence(item) {
  return typeof item?.id === "string" && item.id.endsWith("_Essence");
}

function byName(items) {
  return [...items].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Bank.filterItems() hands its predicate a BankItem. What it *returns* is the plain Item — that
// is how the Enchanting mod itself uses it — but a bank-entry record has been seen coming back
// instead, and the two are easy to confuse: an enchanted item also has an `.item` (its base).
// A BankItem is the one that also carries `.quantity`, so unwrap on that and nothing else.
function unwrap(entry) {
  return entry?.quantity !== undefined && entry?.item !== undefined ? entry.item : entry;
}

// Every bank item matching `pred`, as Items, sorted by name. `pred` is given the Item.
function bankItems(pred) {
  const bank = getBank();
  if (!bank) return [];
  return byName(bank.filterItems((bankItem) => pred(unwrap(bankItem))).map(unwrap));
}

// Every enchanted item in the bank at or below `grade`, locked ones left alone.
function disenchantTargets(ench, grade) {
  if (grade < 0) return [];
  return bankItems(
    (item) => ench.isAugmentedItem(item) && qualityOf(item) <= grade && !isLocked(item),
  );
}

// Everything you could put in an enchant task: plain equipment (an enchant makes it grade 1)
// and enchanted items below Mythic. Locked items never qualify.
function enchantable(ench) {
  return bankItems(
    (item) =>
      !isLocked(item) &&
      (ench.isAugmentedItem(item) || ench.canAugmentItem(item)) &&
      qualityOf(item) < MAX_QUALITY,
  );
}

// Enchanted items with at least one modifier slot are the only things worth rerolling.
function rerollable(ench) {
  return bankItems(
    (item) => ench.isAugmentedItem(item) && item.extraModifiers?.size > 0 && !isLocked(item),
  );
}

// Resolve an id the user picked earlier against what is actually in the bank now. Never use
// getObjectByID for this: the Enchanting mod patches it so that an unresolved `enchanting:`
// id fabricates and registers a brand-new dummy item, which then gets saved.
function findInBank(items, id) {
  return items.find((item) => item.id === id);
}

function actionByID(ench, id) {
  return ench.actions?.getObjectByID?.(id);
}

// Same reason as findInBank: a stale mod id (the Enchanting mod updated, a mod was renamed)
// must come back as undefined, not as an invented object.
function modByID(ench, id) {
  return ench.mods?.allObjects?.find((mod) => mod.id === id);
}

// An EnchantingMod doesn't always carry a display name, and its local id is camelCase —
// "increasedGlobalAccuracy" is not something to show someone. Space it out and capitalise it.
function modName(mod) {
  if (!mod) return "?";
  if (mod.name) return mod.name;
  const local = mod.localID ?? String(mod.id ?? "").split(":").pop();
  return local.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Loot takeover
//
// The Enchanting mod's auto-disenchant is six fields on the skill (autoDisenchantDrops /
// autoDisenchantRewards, -1..5, plus include-common and downgrade flags), read by
// replaceDrop()/replaceRewards() and saved inside the skill's own binary blob. We snapshot
// them, force them to -1 so its code path can never fire, hide its dropdowns, and reimplement
// the behaviour on our settings instead.
// ---------------------------------------------------------------------------

const NATIVE_FIELDS = [
  "autoDisenchantRewards",
  "autoDisenchantDrops",
  "includeCommonRewards",
  "includeCommonDrops",
  "downgradeRewards",
  "downgradeDrops",
];

function snapshotNative(ench) {
  const snapshot = {};
  for (const field of NATIVE_FIELDS) snapshot[field] = ench[field];
  return snapshot;
}

function setNativeUiHidden(hidden) {
  const row = getEnchanting()?.menu?.autoDisenchantRow;
  // A class, not .remove(): the mod itself shows and hides this row whenever you select the
  // Disenchant action, so anything we detach would come back (and anything we hide inline
  // would be un-hidden). Our class outlives both.
  row?.classList?.toggle?.(`${MARK}-hidden`, hidden);
}

function applyTakeover() {
  const ench = getEnchanting();
  if (!ench) return;

  try {
    if (settings.enabled) {
      if (!settings.nativeBackup) {
        settings.nativeBackup = snapshotNative(ench);
        saveSettings();
      }
      ench.autoDisenchantRewards = OFF;
      ench.autoDisenchantDrops = OFF;
      setNativeUiHidden(true);
    } else {
      if (settings.nativeBackup) {
        for (const field of NATIVE_FIELDS) {
          if (settings.nativeBackup[field] !== undefined) ench[field] = settings.nativeBackup[field];
        }
        settings.nativeBackup = null;
        saveSettings();
      }
      setNativeUiHidden(false);
    }
    // Re-reads all six fields into its dropdowns and switches, so they show "None" while we
    // hold them off and the real value again once we hand them back.
    ench.menu?.localize?.();
  } catch (err) {
    warn("could not apply the auto-disenchant takeover", err);
  }
}

// Our replacement for the roll the Enchanting mod does on every drop and every craft reward.
// Deliberately identical to its own, except that it reads our settings — and that the drops
// path consults includeCommonDrops (the mod's own checks includeCommonRewards there, which
// looks like a typo).
function autoDisenchantRoll(ench, item, quantity, weights, totalWeight, forDrops) {
  const pick = getSelectFromWeightedArray();
  const grade = forDrops ? settings.autoDisenchantDrops : settings.autoDisenchantRewards;
  const includeCommon = forDrops ? settings.includeCommonDrops : settings.includeCommonRewards;
  const downgrade = forDrops ? settings.downgradeDrops : settings.downgradeRewards;

  const quality = Math.min(pick(weights, totalWeight).quality, ench.maxQuality ?? MAX_QUALITY);

  if (quality > 0) {
    if (grade >= quality) {
      // Downgrade keeps the plain item instead of the enchanted one; include-common then
      // decides whether that plain item is itself turned into Common essence.
      if (downgrade) {
        if (!includeCommon) return [item, quantity];
        ench.giveAutoDisenchantRewards(item, 0);
        return ench.getEssenceForItem(item, 0, quantity);
      }
      ench.giveAutoDisenchantRewards(item, quality); // half XP, same as the mod's own path
      return ench.getEssenceForItem(item, quality, quantity);
    }
    return [ench.createEnchantingItem(item, quality), quantity];
  }

  if (grade > OFF && includeCommon) {
    ench.giveAutoDisenchantRewards(item, 0);
    return ench.getEssenceForItem(item, 0, quantity);
  }
  return [item, quantity];
}

// Replaces proto[name] outright. Idempotent, and any throw falls back to the original so a
// mistake of ours can never cost you a drop.
function patchReplace(proto, name, wrapper) {
  const original = proto?.[name];
  if (typeof original !== "function" || original[PATCH_FLAG]) return;

  const patched = function (...args) {
    try {
      return wrapper.call(this, original, ...args);
    } catch (err) {
      console.error(`${TAG} ${name} hook failed; using the Enchanting mod's own path`, err);
      return original.apply(this, args);
    }
  };
  patched[PATCH_FLAG] = true;
  proto[name] = patched;
}

// Records what an enchant produced. Read synchronously from the action hook below, where it
// can only be the item that action just made.
function patchItemCreation(proto) {
  const original = proto?.createEnchantingItem;
  if (typeof original !== "function" || original[PATCH_FLAG]) return;

  const patched = function (...args) {
    const result = original.apply(this, args);
    lastCreated = result;
    return result;
  };
  patched[PATCH_FLAG] = true;
  proto.createEnchantingItem = patched;
}

// action() gives the rewards, consumes the costs, and then immediately starts itself again on
// the same item. That is how a disenchant drains a whole stack for us — but for an enchant it
// would burn the rest of the stack up to grade 1 instead of walking one item to its target.
// So an enchant task takes the decision back after every single action.
function patchAction(proto) {
  const original = proto?.action;
  if (typeof original !== "function" || original[PATCH_FLAG]) return;

  const patched = function (...args) {
    const result = original.apply(this, args);
    try {
      const task = runningTask();
      if (task?.kind === "enchant") {
        // Hand the task its new item here and now, not in the deferred callback below. The
        // action has already banked what it made, so the bank can be counted — and doing it
        // synchronously means a Stop landing in between still leaves the task pointing at an
        // item that actually exists.
        job.followed = adoptProduced(this, task);
        // Defer the decision by a macrotask so the mod's own handler is completely done.
        setTimeout(() => onEnchantActionDone(), 0);
      }
    } catch (err) {
      console.error(`${TAG} action hook failed`, err);
    }
    return result;
  };
  patched[PATCH_FLAG] = true;
  proto.action = patched;
}

// Work out which item the enchant we just let finish actually produced.
//
// Asking the mod ("what did createEnchantingItem last return?") is one signal, but a fragile
// one: it depends on our patch landing on the right object, and on nothing else creating an
// item in between. So the answer comes from the bank instead. An enchant banks exactly one of
// the item it made, so we snapshot the possible successors before starting and look for the
// stack that grew.
//
// This is what makes duplicates work. The mod reuses an identical roll rather than making a
// second copy of it, so the "new" item is very often one you already owned — the stack just
// goes from 3 to 4. And several of your items can share a base, a grade and a name while being
// different objects. Counting is the only thing that tells them apart.
function adoptProduced(ench, task) {
  const previous = job.item;
  if (!previous) return false;

  const bank = getBank();
  const before = job.before ?? new Map();
  const grown = successors(ench, previous).filter(
    (candidate) => bank.getQty(candidate) > (before.get(candidate.id) ?? 0),
  );

  // Exactly one stack should have grown. If something else banked a matching item while the
  // enchant was running (a drop, say), fall back to what the mod told us it created.
  const produced =
    grown.length === 1 ? grown[0] : (grown.find((candidate) => candidate === lastCreated) ?? grown[0]);

  if (!produced) {
    warn(
      `could not tell which item the enchant produced from ${previous.name} ` +
        `(grade ${qualityOf(previous)} -> ${qualityOf(previous) + 1}). Is the bank full?`,
      { previous, lastCreated, candidates: successors(ench, previous) },
    );
    return false;
  }

  adoptItem(task, produced);
  saveSettings(); // once per 10-second enchant; cheap, and it makes a Stop safe
  return true;
}

// Whichever object actually owns `name` — the prototype for a normal class method, the instance
// itself if it was written as a class field. Patching the prototype blindly is how a patch ends
// up silently doing nothing.
function ownerOf(object, name) {
  let owner = object;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
  return owner;
}

function installPatches(ench) {
  const proto = Object.getPrototypeOf(ench);
  if (!proto) return;

  for (const name of ["replaceRewards", "replaceDrop", "createEnchantingItem", "action"]) {
    if (!ownerOf(ench, name)) warn(`the Enchanting skill has no ${name}() — that part of the mod will not work`);
  }

  patchReplace(proto, "replaceRewards", function (original, item, quantity) {
    if (!settings.enabled) return original.call(this, item, quantity);
    return autoDisenchantRoll(this, item, quantity, this.rewardWeights, this.totalRewardWeight, false);
  });

  patchReplace(proto, "replaceDrop", function (original, item, quantity) {
    if (!settings.enabled) return original.call(this, item, quantity);
    const [rolled, qty] = autoDisenchantRoll(
      this,
      item,
      quantity,
      this.dropWeights,
      this.totalDropWeight,
      true,
    );
    return { item: rolled, quantity: qty };
  });

  // lastCreated is only a tie-breaker now — adoptProduced() counts the bank — but patch the
  // object that really owns the method, not whatever the prototype happens to have.
  patchItemCreation(ownerOf(ench, "createEnchantingItem") ?? proto);
  patchAction(ownerOf(ench, "action") ?? proto);
}

// ---------------------------------------------------------------------------
// Jobs
//
// One job at a time — the bank sweep and the queue both want the skill's action slot.
// ---------------------------------------------------------------------------

function setStatus(text) {
  lastStatus = text;
  log(text);
  updatePanel();
}

function beginJob(newJob, statusText) {
  if (job) endJob("replaced");
  job = newJob;
  setStatus(statusText);
  driveJob();
  if (job && !driver) driver = setInterval(driveJob, DRIVER_MS);
  updatePanel();
}

function endJob(reason) {
  if (!job) return;

  const ench = getEnchanting();
  try {
    if (ench?.isActive) ench.stop();
  } catch (err) {
    warn("could not stop the Enchanting skill", err);
  }

  // A task we were part-way through goes back to pending, so Start picks it up again.
  const task = runningTask();
  if (task) task.status = "pending";

  job = null;
  if (driver) {
    clearInterval(driver);
    driver = null;
  }
  saveSettings();
  setStatus(reason);
  updatePanel();
}

// Mirrors what clicking an action icon, then an item, then the big button does — minus the
// toggle behaviour of actionButtonOnClick(), which would *stop* a running action.
//
// We do NOT check game.activeAction first. Enchant and Disenchant claim that slot, so starting
// one while you are fighting or woodcutting means stopping what you were doing — but that is
// the game's call to make, through its own idleChecker, exactly as if you had clicked the
// button yourself. If it refuses, start() returns false and the caller stops the job.
function startSkillAction(ench, actionID, item) {
  if (ench.isActive) return false;

  const action = actionByID(ench, actionID);
  if (!action) return false;

  ench.selectActionOnClick(action);
  ench.selectItemOnClick(item);
  // Both setters silently give up if they can't stop what's running (a Golbin raid, say), so
  // confirm the selection actually took rather than starting on the wrong thing.
  if (ench.selectedItem !== item || ench.currentAction !== action) return false;

  const costs = ench.getCurrentActionCosts();
  if (!costs || ench.isCostEmpty(costs) || !costs.checkIfOwned()) return false;

  return ench.start() === true;
}

// True if paying `costs` would take any essence below the floor you set.
function belowEssenceFloor(costs) {
  const floor = settings.essenceFloor;
  if (!(floor > 0) || !costs?.getItemQuantityArray) return false;
  const bank = getBank();
  if (!bank) return false;

  return costs
    .getItemQuantityArray()
    .some(({ item, quantity }) => isEssence(item) && bank.getQty(item) - quantity < floor);
}

function driveJob() {
  if (!job) return;

  const ench = getEnchanting();
  if (!ench) {
    endJob("stopped: the Enchanting mod is gone");
    return;
  }
  if (!settings.enabled) {
    endJob("stopped: automation is off");
    return;
  }

  try {
    if (job.type === "sweep") driveSweep(ench);
    else if (job.type === "queue") driveQueue(ench);
    else endJob("idle");
  } catch (err) {
    console.error(`${TAG} job failed`, err);
    endJob("stopped: something went wrong (see the console)");
  }
}

// --- The bank sweep --------------------------------------------------------

function startSweep() {
  const ench = getEnchanting();
  if (!ench) return;

  if (settings.bankDisenchantGrade < 0) {
    setStatus("pick a grade to disenchant first");
    return;
  }
  const count = disenchantTargets(ench, settings.bankDisenchantGrade).length;
  if (!count) {
    setStatus("nothing in the bank at that grade or below");
    return;
  }

  beginJob(
    {
      type: "sweep",
      grade: settings.bankDisenchantGrade,
      instant: settings.bankDisenchantMode === "instant",
      done: 0,
    },
    `disenchanting ${count} stack${count === 1 ? "" : "s"} of ${qualityName(settings.bankDisenchantGrade)} or below`,
  );
}

function driveSweep(ench) {
  if (job.instant) {
    driveInstantSweep(ench);
    return;
  }

  // Its own action() loop is draining the current stack; let it.
  if (ench.isActive) return;

  const remaining = disenchantTargets(ench, job.grade);
  const next = remaining[0];
  if (!next) {
    endJob(`done: disenchanted ${job.done} stack${job.done === 1 ? "" : "s"}`);
    return;
  }

  if (!startSkillAction(ench, DISENCHANT, next)) {
    // The game turned it down — most likely its "stop what you're doing?" prompt is waiting on
    // you. Answer it and press Start again; we don't retry, or we'd stack modals on you.
    endJob(`stopped: the game wouldn't start a disenchant on ${next.name}`);
    return;
  }
  job.done += 1;
  setStatus(`disenchanting ${next.name} — ${remaining.length} stack${remaining.length === 1 ? "" : "s"} left`);
}

function driveInstantSweep(ench) {
  const targets = disenchantTargets(ench, job.grade);
  if (!targets.length) {
    endJob(`done: instantly disenchanted ${job.done} stack${job.done === 1 ? "" : "s"}`);
    return;
  }

  const bank = getBank();
  for (const item of targets.slice(0, INSTANT_BATCH)) {
    const qty = bank.getQty(item);
    if (qty <= 0) continue;
    if (!instantDisenchant(ench, item, qty)) {
      endJob("stopped: the bank is full");
      return;
    }
    job.done += 1;
  }
  setStatus(`instantly disenchanted ${job.done} stack${job.done === 1 ? "" : "s"}…`);
}

// The Enchanting mod's own instant path (the one it runs on loot) at half XP, but for an item
// that is already in your bank, so we have to take it out ourselves.
//
// We don't call its giveAutoDisenchantRewards() here: that computes XP from
// `this.currentAction.baseXP`, so the XP you'd get would depend on whichever action icon you
// last clicked on the page. On loot that quirk is the mod's own behaviour and we keep it; for
// a bank disenchant we spell out what it's supposed to mean instead — half of the XP the
// Disenchant action would have given.
function instantDisenchant(ench, item, qty) {
  const game = getGame();
  const RewardsClass = getRewardsClass();
  if (!RewardsClass) return false;

  const quality = qualityOf(item);
  const [essence, amount] = ench.getEssenceForItem(item, quality, qty);
  if (!essence || !(amount > 0)) return true;

  const action = actionByID(ench, DISENCHANT);
  const xp = ench.modifyXP(
    (action.baseXP * (quality + 1) * ench.getItemLevelMultiplier(item)) / 2,
    action,
  );

  // Remove first: the freed bank slot is what guarantees the essence has somewhere to land.
  game.bank.removeItemQuantity(item, qty);

  const rewards = new RewardsClass(game);
  rewards.setSource(`Skill.${ench.id}`);
  rewards.addXP(ench, xp);
  rewards.addItem(essence, amount);
  const notAllGiven = rewards.giveRewards();

  ench.queueBankQuantityRender?.(essence);
  return !notAllGiven;
}

// --- The task queue --------------------------------------------------------

function runningTask() {
  if (job?.type !== "queue" || !job.taskID) return undefined;
  return settings.queue.find((task) => task.id === job.taskID);
}

function nextTaskID() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function addTask(task) {
  settings.queue.push({ id: nextTaskID(), status: "pending", note: "", ...task });
  saveSettings();
  updatePanel();
}

function removeTask(id) {
  if (runningTask()?.id === id) endJob("stopped: the running task was removed");
  settings.queue = settings.queue.filter((task) => task.id !== id);
  saveSettings();
  updatePanel();
}

function clearFinished() {
  settings.queue = settings.queue.filter((task) => task.status === "pending" || task.status === "running");
  saveSettings();
  updatePanel();
}

function finishTask(task, status, note) {
  task.status = status;
  task.note = note;
  job.taskID = null;
  job.item = null;
  job.targets = null;
  job.rerolls = 0;
  saveSettings();
  setStatus(`${task.itemName}: ${note}`);
}

function startQueue() {
  const ench = getEnchanting();
  if (!ench) return;

  if (!settings.queue.some((task) => task.status === "pending")) {
    setStatus("nothing queued");
    return;
  }
  beginJob({ type: "queue", taskID: null, item: null, targets: null, produced: null, rerolls: 0 }, "working through the queue");
}

// The items in the bank an enchant of `item` could have produced: same base item, one grade up.
// Several of them can exist at once — same base, same grade, different rolled modifiers — and
// they all share a display name, which is why identifying the new one by name or by grade alone
// does not work.
function successors(ench, item) {
  const base = ench.isAugmentedItem(item) ? item.item : item;
  const quality = qualityOf(item) + 1;
  return bankItems(
    (candidate) =>
      ench.isAugmentedItem(candidate) && candidate.item === base && qualityOf(candidate) === quality,
  );
}

function snapshotSuccessors(ench, item) {
  const bank = getBank();
  const counts = new Map();
  for (const candidate of successors(ench, item)) counts.set(candidate.id, bank.getQty(candidate));
  return counts;
}

// Point a running task at the item it now owns.
//
// An enchant or a reroll REPLACES the item with a new object carrying a new (random) id. The
// task has to be moved with it: if it kept naming the item it started from, stopping the queue
// and starting it again would go looking for an item that has already been consumed, and the
// row would fail. The caller persists — this is called once per reroll, and saving on every
// one of those would be silly.
function adoptItem(task, item) {
  job.item = item;
  task.itemID = item.id;
  task.itemName = item.name;
}

// Search the whole bank, not just the items eligible for this kind of task: an enchant task
// whose item has already reached Mythic is *finished*, not lost, and the drive functions below
// are the ones that say so.
function resolveTaskItem(task) {
  return findInBank(bankItems(() => true), task.itemID);
}

function driveQueue(ench) {
  let task = runningTask();

  if (!task) {
    task = settings.queue.find((entry) => entry.status === "pending");
    if (!task) {
      endJob("done: the queue is finished");
      return;
    }

    const item = resolveTaskItem(task);
    if (!item) {
      finishTask(task, "failed", "not in the bank any more");
      return;
    }
    if (isLocked(item)) {
      finishTask(task, "failed", "the item is locked");
      return;
    }

    task.status = "running";
    job.taskID = task.id;
    job.item = item;
    job.rerolls = 0;
    job.followed = true;

    if (task.kind === "reroll") {
      if (!ench.isAugmentedItem(item)) {
        finishTask(task, "failed", "not an enchanted item any more");
        return;
      }
      const targets = task.modIDs.map((id) => modByID(ench, id)).filter((mod) => mod !== undefined);
      if (!targets.length) {
        finishTask(task, "failed", "none of those modifiers exist any more");
        return;
      }
      job.targets = new Set(targets);
    }
    saveSettings();
  }

  if (task.kind === "enchant") driveEnchantTask(ench, task);
  else driveRerollTask(ench, task);
}

function driveEnchantTask(ench, task) {
  if (ench.isActive) return; // an enchant is running; the action hook takes it from here

  const item = job.item;
  const target = Math.min(task.target, MAX_QUALITY);

  if (qualityOf(item) >= target) {
    finishTask(task, "done", `now ${qualityName(target)}`);
    return;
  }
  if (isLocked(item)) {
    finishTask(task, "failed", "the item is locked");
    return;
  }

  const costs = ench.getEnchantCosts(item);
  if (ench.isCostEmpty(costs)) {
    finishTask(task, "failed", "can't be enchanted any further");
    return;
  }
  if (!costs.checkIfOwned()) {
    finishTask(task, "failed", "not enough essence");
    return;
  }
  if (belowEssenceFloor(costs)) {
    finishTask(task, "failed", `would take an essence below your floor of ${settings.essenceFloor}`);
    return;
  }

  // Count the stacks this enchant could land in, before it lands in one of them.
  job.before = snapshotSuccessors(ench, item);

  if (!startSkillAction(ench, ENCHANT, item)) {
    finishTask(task, "failed", "the game wouldn't start the enchant");
    return;
  }
  setStatus(`enchanting ${item.name} → ${qualityName(qualityOf(item) + 1)}`);
}

// Runs a macrotask after each completed enchant. The mod has already restarted itself on the
// old item by now, so stop it — nothing is lost, since an action's costs are consumed only
// when it finishes — and carry on with the item the action hook adopted.
function onEnchantActionDone() {
  const task = runningTask();
  if (task?.kind !== "enchant") return;

  const ench = getEnchanting();
  if (!ench) return;

  try {
    if (ench.isActive) ench.stop();
  } catch (err) {
    warn("could not stop the Enchanting skill", err);
  }

  if (!job.followed) {
    finishTask(task, "failed", "the enchant produced nothing — is the bank full?");
  }
  driveJob();
}

function driveRerollTask(ench, task) {
  for (let i = 0; i < REROLL_BATCH; i += 1) {
    if (!rerollStep(ench, task)) return;
  }
  // Every reroll gave the task a new item id. Persist once per batch rather than per reroll,
  // so a Stop (or a reload) resumes from the item the task actually holds now.
  saveSettings();
  setStatus(`rerolling ${job.item.name} (${job.rerolls}/${settings.rerollMax})`);
}

// One reroll, or a reason the task is over. Returns false once it is.
function rerollStep(ench, task) {
  const item = job.item;
  const bank = getBank();

  if (!item || bank.getQty(item) <= 0) {
    finishTask(task, "failed", "the item is no longer in the bank");
    return false;
  }
  if (isLocked(item)) {
    finishTask(task, "failed", "the item is locked");
    return false;
  }

  // Done as soon as every modifier you asked for is on the item — the others can be anything.
  const missing = [...job.targets].filter((mod) => !item.extraModifiers.has(mod));
  if (!missing.length) {
    finishTask(task, "done", `rolled it in ${job.rerolls} reroll${job.rerolls === 1 ? "" : "s"}`);
    return false;
  }

  // Only ever reroll a slot holding something you didn't ask for. A reroll can't hand back a
  // modifier the item already has, so the ones you wanted are never at risk.
  const slot = [...item.extraModifiers].find((mod) => !job.targets.has(mod));
  if (!slot) {
    finishTask(task, "failed", "not enough modifier slots for all of those");
    return false;
  }
  if (job.rerolls >= settings.rerollMax) {
    finishTask(task, "failed", `gave up after ${settings.rerollMax} rerolls`);
    return false;
  }

  const costs = ench.getRerollCosts(item);
  if (belowEssenceFloor(costs)) {
    finishTask(task, "failed", `would take an essence below your floor of ${settings.essenceFloor}`);
    return false;
  }

  const next = rerollSlot(ench, item, slot);
  if (!next) {
    finishTask(task, "failed", "out of essence, or the bank is full");
    return false;
  }

  adoptItem(task, next);
  job.rerolls += 1;
  return true;
}

// What executeReroll() does, minus the DOM. The mod picks the modifier to reroll by reading a
// radio button off its page, so there is no way to ask it for a particular slot; this takes
// the slot as an argument instead. Everything it does to the bank is the same.
function rerollSlot(ench, item, modToReplace) {
  const game = getGame();
  const roll = getRollInteger();

  const costs = ench.getRerollCosts(item);
  if (ench.isCostEmpty(costs) || !costs.checkIfOwned()) return null;

  const mods = [...item.extraModifiers];
  const slot = mods.indexOf(modToReplace);
  if (slot < 0) return null;

  mods[slot] = undefined;
  const pool = ench.getPossibleMods(item.item, item.quality).filter((mod) => !mods.includes(mod));
  if (!pool.length) return null;
  mods[slot] = pool[roll(0, pool.length - 1)];

  const rerolled = ench.createEnchantingItem(
    item.item,
    item.quality,
    new Set(mods),
    item.extraSpecials,
  );
  if (rerolled === undefined) return null;

  if (!game.bank.addItem(rerolled, 1, true, true, false, false)) return null;
  game.bank.removeItemQuantity(item, 1);
  costs.consumeCosts();

  // The item you were looking at on the Enchanting page has just become a different object.
  if (ench.selectedItem === item) {
    ench.selectedItem = rerolled;
    ench.renderQueue.selectedItem = true;
  }
  ench.renderQueue.quantities = true;
  return rerolled;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

let panelEl = null;
const parts = {};

function injectStyles() {
  if (document.getElementById(`${MARK}-styles`)) return;
  const style = document.createElement("style");
  style.id = `${MARK}-styles`;
  style.textContent = `
    .${MARK}-hidden { display: none !important; }
    .${MARK}-panel { margin-bottom: 1rem; }
    .${MARK}-panel .block-content { padding-bottom: .75rem; }

    .${MARK}-section + .${MARK}-section { margin-top: .5rem; border-top: 1px solid rgba(128,128,128,.2); }
    .${MARK}-section { padding-top: .75rem; }
    .${MARK}-title {
      margin: 0 0 .5rem; font-size: .75rem; font-weight: 700;
      letter-spacing: .06em; text-transform: uppercase; opacity: .65;
    }

    .${MARK}-line { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .75rem; }
    .${MARK}-line + .${MARK}-line { margin-top: .5rem; }
    .${MARK}-field { display: flex; flex-direction: column; gap: .15rem; }
    .${MARK}-field > span { font-size: .7rem; font-weight: 600; opacity: .7; }
    .${MARK}-field select, .${MARK}-field input { min-width: 8rem; }
    .${MARK}-field-wide select { min-width: 18rem; }
    .${MARK}-check { display: flex; align-items: center; gap: .3rem; height: 2rem; }
    .${MARK}-check label { margin: 0; font-weight: 400; cursor: pointer; }
    .${MARK}-spacer { flex: 1 1 auto; }
    .${MARK}-note { font-size: .8rem; opacity: .6; }

    .${MARK}-table { width: 100%; margin: .5rem 0 0; }
    .${MARK}-table th { font-size: .7rem; text-transform: uppercase; opacity: .6; }
    .${MARK}-table th, .${MARK}-table td { padding: .3rem .5rem; vertical-align: middle; }
    .${MARK}-table select { max-width: 10rem; }

    .${MARK}-status { margin-top: .75rem; font-size: .85rem; opacity: .75; }
    .${MARK}-pending { opacity: .7; }
    .${MARK}-running { font-weight: 600; }
    .${MARK}-done { color: #46c37b; }
    .${MARK}-failed { color: #d26a5c; }

    /* The item you have picked, standing in for a dropdown. */
    .${MARK}-pick { display: inline-flex; align-items: center; gap: .4rem; min-width: 16rem; justify-content: flex-start; }
    .${MARK}-pick-img { width: 24px; height: 24px; object-fit: contain; }
    .${MARK}-pick-img[hidden] { display: none; }

    .${MARK}-task-item { white-space: nowrap; }
    .${MARK}-task-img { width: 20px; height: 20px; object-fit: contain; margin-right: .35rem; vertical-align: middle; }

    /* The picker overlay. */
    .${MARK}-overlay {
      position: fixed; inset: 0; z-index: 100000;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, .6);
    }
    .${MARK}-overlay[hidden] { display: none; }
    .${MARK}-picker {
      display: flex; flex-direction: column;
      width: min(900px, 92vw); max-height: 82vh;
      padding: 16px; border-radius: 8px;
      background: var(--bs-body-bg, #2d2f36);
      color: var(--bs-body-color, #cfd2da);
      box-shadow: 0 12px 40px rgba(0, 0, 0, .5);
    }
    .${MARK}-picker-bar { display: flex; align-items: center; gap: .5rem; margin-bottom: .75rem; }
    .${MARK}-picker-bar .block-title { margin: 0; flex: 0 0 auto; }
    .${MARK}-search { flex: 1 1 auto; }

    .${MARK}-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
      grid-auto-rows: 60px; /* a definite row height, so icons never overlap */
      gap: 6px;
      flex: 1 1 auto; min-height: 0; /* let it scroll rather than blow the panel open */
      overflow-y: auto; padding: 4px;
    }
    .${MARK}-cell {
      position: relative;
      display: flex; align-items: center; justify-content: center;
      padding: 4px; overflow: hidden;
      border: 1px solid transparent; border-radius: 6px;
      background: rgba(255, 255, 255, .04);
      cursor: pointer;
      transition: transform .06s ease, border-color .06s ease;
    }
    .${MARK}-cell img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
    .${MARK}-cell:hover { border-color: var(--bs-primary, #4c84ff); transform: scale(1.08); background: rgba(255,255,255,.1); }
    .${MARK}-cell-qty {
      position: absolute; right: 2px; bottom: 1px;
      font-size: 10px; font-weight: 600; line-height: 1;
      padding: 1px 3px; border-radius: 3px;
      background: rgba(0, 0, 0, .65); color: #fff;
      pointer-events: none;
    }

    .${MARK}-pager { display: flex; align-items: center; justify-content: center; gap: .75rem; padding-top: .5rem; }
    .${MARK}-hint { font-size: .8rem; opacity: .7; }

    .${MARK}-tip {
      position: fixed; z-index: 100001; pointer-events: none;
      max-width: 22rem; padding: 6px 10px; border-radius: 4px;
      background: rgba(15, 16, 20, .96); color: #fff;
      font-size: 12px; line-height: 1.35;
      box-shadow: 0 4px 12px rgba(0, 0, 0, .5);
    }
    .${MARK}-tip[hidden] { display: none; }
    .${MARK}-tip-head { margin-top: .35rem; font-weight: 600; opacity: .75; }
    .${MARK}-tip-sub { opacity: .7; }
    .${MARK}-tip-locked { margin-top: .35rem; color: #f0ad4e; }
  `;
  document.head.append(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title) {
  const wrap = el("div", `${MARK}-section`);
  wrap.append(el("h4", `${MARK}-title`, title));
  return wrap;
}

function line() {
  return el("div", `${MARK}-line`);
}

// Buttons sit in their own box so they line up with the bottom of the labelled fields beside
// them rather than with the labels.
function buttons(...nodes) {
  const wrap = el("div", `${MARK}-check`);
  wrap.append(...nodes);
  return wrap;
}

// A labelled control, stacked so every row lines up on the same baseline.
function field(label, control, wide) {
  const wrap = el("div", `${MARK}-field${wide ? ` ${MARK}-field-wide` : ""}`);
  wrap.append(el("span", null, label), control);
  return wrap;
}

function checkbox(key, label) {
  const wrap = el("div", `${MARK}-check`);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = `${MARK}-${key}`;
  input.checked = Boolean(settings[key]);
  input.addEventListener("change", () => {
    settings[key] = input.checked;
    saveSettings();
    if (key === "enabled") {
      syncSettingsSection();
      applyTakeover();
      if (!input.checked) endJob("stopped: automation is off");
    }
    updatePanel();
  });

  const text = document.createElement("label");
  text.htmlFor = input.id;
  text.textContent = label;

  wrap.append(input, text);
  parts[key] = input;
  return wrap;
}

function select(options, value, onChange) {
  const node = el("select", "form-control form-control-sm");
  for (const [optionValue, optionText] of options) {
    const option = document.createElement("option");
    option.value = String(optionValue);
    option.textContent = optionText;
    node.append(option);
  }
  node.value = String(value);
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

function gradeOptions({ includeOff = false, from = 0 } = {}) {
  const options = includeOff ? [[OFF, "Off"]] : [];
  for (let quality = from; quality <= MAX_QUALITY; quality += 1) options.push([quality, QUALITIES[quality]]);
  return options;
}

function gradeSelect(key, options) {
  return select(gradeOptions(options), settings[key], (value) => {
    settings[key] = Number(value);
    saveSettings();
    updatePanel();
  });
}

function numberInput(key, min = 0) {
  const input = el("input", "form-control form-control-sm");
  input.type = "number";
  input.min = String(min);
  input.value = String(settings[key]);
  input.addEventListener("change", () => {
    const value = Number(input.value);
    settings[key] = Number.isFinite(value) && value >= min ? value : DEFAULTS[key];
    input.value = String(settings[key]);
    saveSettings();
  });
  return input;
}

function button(label, className, onClick) {
  const node = el("button", `btn btn-sm ${className}`, label);
  node.addEventListener("click", onClick);
  return node;
}

// ---------------------------------------------------------------------------
// Item picker
//
// A grid of icons in an overlay, the same shape as requirement-filler's item adder: search,
// page, click to pick. Icons beat a dropdown here because an item's grade is the thing you are
// choosing by, and several of your items share a name — "Uncommon Fury of the Elemental
// Zodiacs" three times over tells you nothing, while three icons and a tooltip do.
//
// The grade colouring is free: an enchanted item's .media already ends in "#q=<grade>", and the
// Enchanting mod's own stylesheet paints any img whose src carries that.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 300;

// The item each picker currently holds. Not persisted — it's what the next Add will use, not a
// setting. Keyed by id as well, so we can tell when the bank has moved on from it.
const picked = { enchant: null, reroll: null };

let picker = null; // the overlay, built once on first open

function itemMedia(item) {
  return item?.media ?? "";
}

// Everything the panel knows about an item, for the hover tooltip: what it is, what it rolled,
// and what it would turn back into.
function itemTooltip(ench, item) {
  const bank = getBank();
  const quality = qualityOf(item);
  const lines = [];

  lines.push(`<div class="font-w600 text-enchanting-quality-${quality}">${item.name}</div>`);
  lines.push(`<div class="${MARK}-tip-sub">${qualityName(quality)} · ${bank?.getQty?.(item) ?? 0} in bank</div>`);

  const mods = [...(item.extraModifiers ?? [])];
  if (mods.length) {
    lines.push(`<div class="${MARK}-tip-head">Modifiers</div>`);
    for (const mod of mods) lines.push(`<div>${modName(mod)}</div>`);
  }

  const specials = [...(item.extraSpecials ?? [])];
  if (specials.length) {
    lines.push(`<div class="${MARK}-tip-head">Specials</div>`);
    for (const special of specials) lines.push(`<div>${special.name ?? special.localID ?? special.id}</div>`);
  }

  try {
    const [essence, amount] = ench.getEssenceForItem(item, quality);
    if (essence) lines.push(`<div class="${MARK}-tip-sub">Disenchants into ${amount}x ${essence.name}</div>`);
  } catch {
    // A tooltip is never worth an exception.
  }

  if (isLocked(item)) lines.push(`<div class="${MARK}-tip-locked">Locked — bulk jobs skip it</div>`);

  return lines.join("");
}

function buildPicker() {
  const overlay = el("div", `${MARK}-overlay`);
  overlay.hidden = true;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closePicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && picker && !picker.overlay.hidden) closePicker();
  });

  const panel = el("div", `${MARK}-picker`);
  overlay.append(panel);

  const bar = el("div", `${MARK}-picker-bar`);
  const title = el("h3", "block-title", "Pick an item");

  const search = el("input", `form-control form-control-sm ${MARK}-search`);
  search.type = "search";
  search.placeholder = "Search…";
  search.addEventListener("input", () => {
    picker.page = 0;
    renderPicker();
  });

  const close = button("Close", "btn-secondary", closePicker);
  bar.append(title, search, close);

  const grid = el("div", `${MARK}-grid`);

  const hint = el("div", `${MARK}-hint`);
  const pager = el("div", `${MARK}-pager`);
  const prev = button("‹ Prev", "btn-secondary", () => {
    picker.page = Math.max(0, picker.page - 1);
    renderPicker();
  });
  const next = button("Next ›", "btn-secondary", () => {
    picker.page += 1;
    renderPicker();
  });
  pager.append(prev, hint, next);

  const tip = el("div", `${MARK}-tip`);
  tip.hidden = true;

  // Delegated, so a re-render never leaves a stale listener behind.
  grid.addEventListener("mouseover", (event) => {
    const cell = event.target?.closest?.(`.${MARK}-cell`);
    const item = cell?.__item;
    if (!item) return;
    tip.innerHTML = itemTooltip(getEnchanting(), item);
    tip.hidden = false;
    positionTip(tip, event.clientX, event.clientY);
  });
  grid.addEventListener("mousemove", (event) => {
    if (!tip.hidden) positionTip(tip, event.clientX, event.clientY);
  });
  grid.addEventListener("mouseout", (event) => {
    if (!event.relatedTarget?.closest?.(`.${MARK}-cell`)) tip.hidden = true;
  });
  grid.addEventListener("click", (event) => {
    const item = event.target?.closest?.(`.${MARK}-cell`)?.__item;
    if (!item) return;
    tip.hidden = true;
    picker.onPick?.(item);
    closePicker();
  });

  panel.append(bar, grid, pager);
  overlay.append(tip);
  document.body.append(overlay);

  picker = { overlay, title, search, grid, hint, prev, next, tip, items: [], page: 0, onPick: null };
  return picker;
}

function positionTip(tip, x, y) {
  const offset = 14;
  const width = tip.offsetWidth ?? 0;
  let left = x + offset;
  if (left + width > (globalThis.innerWidth ?? 1920) - 8) left = x - width - offset;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${y + offset}px`;
}

function pickerMatches() {
  const needle = String(picker.search.value ?? "").trim().toLowerCase();
  if (!needle) return picker.items;
  return picker.items.filter((item) => item.name.toLowerCase().includes(needle));
}

function renderPicker() {
  const ench = getEnchanting();
  const bank = getBank();
  const matches = pickerMatches();

  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  picker.page = Math.min(picker.page, pages - 1);
  const shown = matches.slice(picker.page * PAGE_SIZE, picker.page * PAGE_SIZE + PAGE_SIZE);

  const cells = shown.map((item) => {
    const cell = el("button", `${MARK}-cell`);
    cell.type = "button";
    cell.setAttribute("aria-label", item.name);
    cell.__item = item;

    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = itemMedia(item); // carries #q=<grade>, which the Enchanting mod's CSS colours
    img.alt = item.name;
    cell.append(img);

    const qty = el("span", `${MARK}-cell-qty`, String(bank?.getQty?.(item) ?? 0));
    cell.append(qty);

    if (ench?.isAugmentedItem?.(item)) cell.classList.add(`${MARK}-q${qualityOf(item)}`);
    return cell;
  });

  picker.grid.replaceChildren(...cells);
  picker.hint.textContent = matches.length
    ? `${matches.length} item${matches.length === 1 ? "" : "s"} · page ${picker.page + 1} of ${pages}`
    : "nothing eligible";
  picker.prev.disabled = picker.page === 0;
  picker.next.disabled = picker.page >= pages - 1;
}

function openPicker(title, items, onPick) {
  if (!picker) buildPicker();
  picker.items = items;
  picker.onPick = onPick;
  picker.page = 0;
  picker.title.textContent = title;
  picker.search.value = "";
  picker.overlay.hidden = false;
  renderPicker();
  picker.search.focus?.();
}

function closePicker() {
  if (!picker) return;
  picker.overlay.hidden = true;
  picker.tip.hidden = true;
}

// The button that stands in for a dropdown: shows what you picked, opens the grid when clicked.
function pickerButton(slot, title, itemsFor) {
  const node = el("button", `btn btn-sm btn-outline-info ${MARK}-pick`);
  node.type = "button";

  const img = document.createElement("img");
  img.className = `${MARK}-pick-img`;
  const label = el("span", null, "Pick an item");
  node.append(img, label);

  node.addEventListener("click", () => {
    const ench = getEnchanting();
    if (!ench) return;
    openPicker(title, itemsFor(ench), (item) => {
      picked[slot] = item;
      if (slot === "reroll") refreshModList(true);
      updatePanel();
    });
  });

  node.__img = img;
  node.__label = label;
  return node;
}

// The pick is an item object; the bank can move on from it (you enchanted it, you sold it), so
// re-resolve it by id every refresh and drop it if it's gone.
function refreshPick(ench, slot, node, items) {
  if (!node) return;
  const current = picked[slot];
  if (current) picked[slot] = findInBank(items, current.id) ?? null;

  const item = picked[slot];
  node.__img.src = item ? itemMedia(item) : "";
  node.__img.hidden = !item;
  node.__label.textContent = item
    ? `${item.name} (${getBank()?.getQty?.(item) ?? 0})`
    : items.length
      ? "Pick an item"
      : "Nothing eligible";
  node.disabled = !items.length;
}

// --- Sections --------------------------------------------------------------

function buildLootSection() {
  const wrap = section("Auto-disenchant new loot");

  const table = el("table", `table table-sm ${MARK}-table`);
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const text of ["Source", "Disenchant up to", "Include Common", "Downgrade"]) {
    headRow.append(el("th", null, text));
  }
  head.append(headRow);

  const body = document.createElement("tbody");
  for (const [label, gradeKey, commonKey, downgradeKey] of [
    ["Crafting rewards", "autoDisenchantRewards", "includeCommonRewards", "downgradeRewards"],
    ["Other drops", "autoDisenchantDrops", "includeCommonDrops", "downgradeDrops"],
  ]) {
    const row = document.createElement("tr");
    const name = el("td", null, label);

    const grade = document.createElement("td");
    grade.append(gradeSelect(gradeKey, { includeOff: true }));

    const common = document.createElement("td");
    common.append(checkbox(commonKey, ""));

    const downgrade = document.createElement("td");
    downgrade.append(checkbox(downgradeKey, ""));

    row.append(name, grade, common, downgrade);
    body.append(row);
  }
  table.append(head, body);

  wrap.append(
    table,
    el(
      "div",
      `${MARK}-note`,
      "Replaces the Enchanting mod's own auto-disenchant. Instant, at half XP, exactly as before.",
    ),
  );
  return wrap;
}

function buildSweepSection() {
  const wrap = section("Disenchant the bank");

  const count = el("span", `${MARK}-note`);
  parts.sweepCount = count;

  const sweepButton = button("Start", "btn-success", () => {
    if (job?.type === "sweep") endJob("stopped");
    else startSweep();
  });
  parts.sweepButton = sweepButton;

  const controls = line();
  controls.append(
    field("Grade and below", gradeSelect("bankDisenchantGrade", { includeOff: true })),
    field(
      "Mode",
      select(
        [
          ["skill", "Use the skill (full XP)"],
          ["instant", "Instant (half XP)"],
        ],
        settings.bankDisenchantMode,
        (value) => {
          settings.bankDisenchantMode = value;
          saveSettings();
          updatePanel();
        },
      ),
    ),
    buttons(sweepButton, count),
  );

  wrap.append(
    controls,
    el(
      "div",
      `${MARK}-note`,
      "Locked items are always skipped. Skill mode uses the Enchanting action slot, so it stops whatever else you were doing — same as clicking Disenchant yourself.",
    ),
  );
  return wrap;
}

function buildQueueSection() {
  const wrap = section("Task queue");

  // Add an enchant task.
  const enchantItem = pickerButton("enchant", "Pick an item to enchant", (ench) => enchantable(ench));
  parts.enchantItem = enchantItem;

  // Not persisted: it's what the next Add will use, not a setting.
  const enchantGrade = select(gradeOptions({ from: 1 }), 3, () => {});
  parts.enchantGrade = enchantGrade;

  const addEnchant = line();
  addEnchant.append(
    field("Enchant", enchantItem, true),
    field("Up to", enchantGrade),
    buttons(button("Add", "btn-primary", onAddEnchant)),
  );

  // Add a reroll task.
  const rerollItem = pickerButton("reroll", "Pick an item to reroll", (ench) => rerollable(ench));
  parts.rerollItem = rerollItem;

  const mods = el("select", `form-control form-control-sm ${MARK}-mods`);
  mods.multiple = true;
  mods.size = 4;
  mods.__options = null;
  parts.rerollMods = mods;

  const addReroll = line();
  addReroll.append(
    field("Reroll", rerollItem, true),
    field("Until it has", mods, true),
    buttons(button("Add", "btn-primary", onAddReroll)),
  );

  // The queue itself.
  const table = el("table", `table table-sm ${MARK}-table`);
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const text of ["Task", "Item", "Goal", "Status", ""]) headRow.append(el("th", null, text));
  head.append(headRow);
  const body = document.createElement("tbody");
  table.append(head, body);
  parts.queueBody = body;
  parts.queueKey = "";

  const runButton = button("Start queue", "btn-success", () => {
    if (job?.type === "queue") endJob("stopped");
    else startQueue();
  });
  parts.queueButton = runButton;

  const controls = line();
  controls.append(
    field("Keep essence above", numberInput("essenceFloor")),
    field("Reroll cap", numberInput("rerollMax", 1)),
    el("div", `${MARK}-spacer`),
    buttons(runButton, button("Clear finished", "btn-secondary", clearFinished)),
  );

  wrap.append(addEnchant, addReroll, table, controls);
  return wrap;
}

function onAddEnchant() {
  const ench = getEnchanting();
  if (!ench) return;

  const item = picked.enchant && findInBank(enchantable(ench), picked.enchant.id);
  if (!item) {
    setStatus("pick an item to enchant first");
    return;
  }
  const target = Number(parts.enchantGrade.value);
  if (qualityOf(item) >= target) {
    setStatus(`${item.name} is already ${qualityName(qualityOf(item))}`);
    return;
  }

  addTask({ kind: "enchant", itemID: item.id, itemName: item.name, target });
  setStatus(`queued: enchant ${item.name} to ${qualityName(target)}`);
}

function onAddReroll() {
  const ench = getEnchanting();
  if (!ench) return;

  const item = picked.reroll && findInBank(rerollable(ench), picked.reroll.id);
  if (!item) {
    setStatus("pick an item to reroll first");
    return;
  }

  const modIDs = [...parts.rerollMods.selectedOptions].map((option) => option.value);
  if (!modIDs.length) {
    setStatus("pick at least one modifier you want");
    return;
  }
  // Refuse the impossible up front rather than after a few hundred rerolls.
  if (modIDs.length > item.extraModifiers.size) {
    setStatus(
      `${item.name} has only ${item.extraModifiers.size} modifier slot${
        item.extraModifiers.size === 1 ? "" : "s"
      } — you picked ${modIDs.length}`,
    );
    return;
  }

  const names = modIDs.map((id) => modName(modByID(ench, id)));
  addTask({ kind: "reroll", itemID: item.id, itemName: item.name, modIDs, modNames: names });
  setStatus(`queued: reroll ${item.name} until ${names.join(" + ")}`);
}

// The modifiers on offer depend on the item: its base type, its grade, and your skill level.
function refreshModList(force) {
  const ench = getEnchanting();
  const node = parts.rerollMods;
  if (!ench || !node) return;

  const item = picked.reroll;
  const pool = item ? [...ench.getPossibleMods(item.item, item.quality)] : [];
  pool.sort((a, b) => modName(a).localeCompare(modName(b)));

  const key = pool.map((mod) => mod.id).join(",");
  if (!force && node.__options === key) return;
  node.__options = key;

  node.replaceChildren();
  for (const mod of pool) {
    const option = document.createElement("option");
    option.value = mod.id;
    option.textContent = modName(mod);
    node.append(option);
  }
}

function goalText(task) {
  if (task.kind === "enchant") return `to ${qualityName(task.target)}`;
  return (task.modNames ?? task.modIDs ?? []).join(" + ");
}

function refreshQueueTable() {
  const body = parts.queueBody;
  if (!body) return;

  // Rebuild only when something actually changed, so clicking Remove isn't a race with the
  // 1-second refresh.
  // The item a task holds changes as it climbs the grades, so it belongs in the key too.
  const key = settings.queue
    .map((task) => `${task.id}:${task.status}:${task.note}:${task.itemID}:${task.itemName}`)
    .join("|");
  if (parts.queueKey === key) return;
  parts.queueKey = key;

  body.replaceChildren();

  if (!settings.queue.length) {
    const row = document.createElement("tr");
    const cell = el("td", `${MARK}-note`, "Nothing queued yet.");
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
    return;
  }

  const ench = getEnchanting();

  for (const task of settings.queue) {
    const row = document.createElement("tr");

    // The task tracks the item it holds *now*, so show that: an enchant task renames itself as
    // it climbs the grades, and the icon recolours with it.
    const live = ench && findInBank(bankItems(() => true), task.itemID);
    const itemCell = el("td", `${MARK}-task-item`);
    if (live) {
      const img = document.createElement("img");
      img.className = `${MARK}-task-img`;
      img.src = itemMedia(live);
      img.alt = "";
      itemCell.append(img);
    }
    itemCell.append(el("span", `text-enchanting-quality-${qualityOf(live)}`, task.itemName));

    row.append(
      el("td", null, task.kind === "enchant" ? "Enchant" : "Reroll"),
      itemCell,
      el("td", null, goalText(task)),
      el("td", `${MARK}-${task.status}`, task.note ? `${task.status} — ${task.note}` : task.status),
    );

    const remove = document.createElement("td");
    remove.append(button("✕", "btn-secondary", () => removeTask(task.id)));
    row.append(remove);
    body.append(row);
  }
}

function buildPanel() {
  const panel = el("div", `block block-rounded ${MARK}-panel`);

  const header = el("div", "block-header block-header-default");
  header.append(el("h3", "block-title", "Auto Enchanting"), checkbox("enabled", "Automation enabled"));

  const content = el("div", "block-content");
  content.append(buildLootSection(), buildSweepSection(), buildQueueSection());

  const status = el("div", `${MARK}-status`);
  parts.status = status;
  content.append(status);

  panel.append(header, content);
  return panel;
}

function updatePanel() {
  if (!panelEl) return;
  const ench = getEnchanting();
  if (!ench) return;

  if (parts.enabled) parts.enabled.checked = settings.enabled;

  const matching = disenchantTargets(ench, settings.bankDisenchantGrade).length;
  if (parts.sweepCount) {
    parts.sweepCount.textContent =
      settings.bankDisenchantGrade < 0
        ? "pick a grade"
        : `${matching} stack${matching === 1 ? "" : "s"} match`;
  }

  refreshPick(ench, "enchant", parts.enchantItem, enchantable(ench));
  refreshPick(ench, "reroll", parts.rerollItem, rerollable(ench));
  refreshModList(false);
  refreshQueueTable();

  const sweeping = job?.type === "sweep";
  const queueing = job?.type === "queue";

  if (parts.sweepButton) {
    parts.sweepButton.textContent = sweeping ? "Stop" : "Start";
    parts.sweepButton.className = `btn btn-sm ${sweeping ? "btn-danger" : "btn-success"}`;
    parts.sweepButton.disabled = !settings.enabled || queueing;
  }
  if (parts.queueButton) {
    parts.queueButton.textContent = queueing ? "Stop queue" : "Start queue";
    parts.queueButton.className = `btn btn-sm ${queueing ? "btn-danger" : "btn-success"}`;
    parts.queueButton.disabled = !settings.enabled || sweeping;
  }

  if (parts.status) {
    parts.status.textContent = settings.enabled ? `Status: ${lastStatus}` : "Automation is off.";
  }
}

function mountPanel() {
  const container = document.getElementById("enchanting-container");
  if (!container) {
    warn("#enchanting-container not found; the panel will not be shown.");
    return;
  }
  panelEl = buildPanel();

  // Sit directly under the skill header (the level/XP bars), above the action menu and the
  // item grid. Fall back to the top of the page if that block ever moves.
  const skillInfo = container.querySelector(".skill-info");
  if (skillInfo) skillInfo.after(panelEl);
  else container.prepend(panelEl);

  updatePanel();
  setInterval(updatePanel, 1000);
}

// ---------------------------------------------------------------------------
// Settings section (so the master switch is reachable without opening Enchanting)
// ---------------------------------------------------------------------------

let settingsSection = null;

function registerSettings(ctx) {
  try {
    settingsSection = ctx?.settings?.section?.("Auto Enchanting");
    settingsSection?.add?.({
      type: "switch",
      name: "enabled",
      label: "Automation enabled",
      hint: "Takes over the Enchanting mod's auto-disenchant. Bulk jobs live on the Enchanting page.",
      default: false,
      onChange: (value) => {
        settings.enabled = value;
        saveSettings();
        applyTakeover();
        if (!value) endJob("stopped: automation is off");
        updatePanel();
      },
    });
  } catch (err) {
    warn("could not register settings section", err);
  }
}

// This switch is account-wide but our settings are per-character, so push the loaded
// character's value into it — otherwise it would show the previous character's state.
function syncSettingsSection() {
  try {
    settingsSection?.set?.("enabled", settings.enabled);
  } catch (err) {
    warn("could not sync the settings switch", err);
  }
}

// ---------------------------------------------------------------------------

export function setup(ctx) {
  // A fallback handle, so a mod reloaded into an already-running game (which never gets
  // onCharacterLoaded) can still save. The real one comes from the lifecycle hook below:
  // the wiki is explicit that character storage isn't available until a character has loaded,
  // and every hook is handed the context to read it from.
  storage = ctx.characterStorage ?? null;

  registerSettings(ctx);

  ctx.onCharacterLoaded((loadedCtx) => {
    storage = loadedCtx?.characterStorage ?? storage;
    loadSettings();
    checkStorage();
    syncSettingsSection();
  });

  ctx.onInterfaceReady(() => {
    const ench = getEnchanting();
    if (!ench) {
      warn("game.enchanting not found — is the Enchanting mod installed and enabled? Doing nothing.");
      return;
    }

    // A mod reloaded into a running game misses onCharacterLoaded, so settings would still be
    // at their defaults here. Load them if that hook never ran.
    if (!settingsLoaded) {
      storage = ctx.characterStorage ?? storage;
      loadSettings();
      checkStorage();
      syncSettingsSection();
    }

    injectStyles();
    installPatches(ench);
    applyTakeover();
    mountPanel();

    // Console handle for debugging persistence: autoEnchanting.dump() / .save() / .reset()
    globalThis.autoEnchanting = {
      get settings() {
        return settings;
      },
      get job() {
        return job;
      },
      stored: () => storage?.getItem?.(STORAGE_KEY),
      save: () => saveSettings(),
      check: () => checkStorage(),
      stop: () => endJob("stopped by hand"),
      dump() {
        console.log({
          live: settings,
          stored: this.stored(),
          hasStorage: !!storage,
          storageWorks: checkStorage(),
          bytes: JSON.stringify(settings).length,
          job,
        });
      },
      reset() {
        settings = structuredClone(DEFAULTS);
        saveSettings();
        applyTakeover();
        updatePanel();
      },
    };

    log(`Loaded. ${ench.equipment?.size ?? 0} enchanted items known, ${ench.mods?.size ?? 0} modifiers.`);
  });
}
