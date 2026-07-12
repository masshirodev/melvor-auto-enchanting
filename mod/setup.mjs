// Auto Enchanting
// Bulk operations for the Enchanting mod: disenchant your bank by grade, enchant items up to
// a target grade, and reroll an item until it has the modifiers you want. Also takes over the
// Enchanting mod's auto-disenchant of new loot, so every option lives in one place.
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

  // Bank jobs. Every one of these spends, so they all start idle and are run by hand.
  bankDisenchantGrade: OFF,
  bankDisenchantMode: "skill", // "skill" = full XP, uses the skill | "instant" = half XP, does not
  enchantTarget: 1,
  enchantScope: "single", // "single" = the picked item | "all" = every eligible bank item
  essenceFloor: 0, // never spend an essence below this quantity
  rerollTargetModIDs: [],
  rerollMax: 500,
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
      settings.enabled = readEnabledSetting(settings.enabled);
      settingsLoaded = true;
      return;
    }
    const legacyEnabled = typeof saved.enabled === "boolean" ? saved.enabled : settings.enabled;
    settings = {
      ...structuredClone(DEFAULTS),
      ...saved,
      enabled: readEnabledSetting(legacyEnabled),
      rerollTargetModIDs: saved.rerollTargetModIDs ?? [],
    };
    settingsLoaded = true;
    log("settings loaded", settings);
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
    // Round-trip through JSON so we can never hand characterStorage something
    // unserialisable, and so what we store is exactly what we'll read back.
    // `enabled` is owned by ctx.settings, which the game already persists per character.
    const { enabled, ...storedSettings } = settings;
    storage.setItem(STORAGE_KEY, JSON.parse(JSON.stringify(storedSettings)));

    // characterStorage is only written into the save file when the game next saves. Without
    // this, changing a setting and then reloading (or closing the tab) before the next
    // autosave loses it — which is the whole "my settings don't persist" symptom.
    getGame()?.scheduleSave?.();
  } catch (err) {
    warn("could not save settings", err);
  }
}

function readEnabledSetting(fallback = settings.enabled) {
  try {
    const value = settingsSection?.get?.("enabled");
    return typeof value === "boolean" ? value : Boolean(fallback);
  } catch (err) {
    warn("could not read the settings switch", err);
    return Boolean(fallback);
  }
}

let syncingSettingsSection = false;
function writeEnabledSetting(value) {
  try {
    if (!settingsSection?.set) return;
    syncingSettingsSection = true;
    settingsSection.set("enabled", Boolean(value));
  } catch (err) {
    warn("could not write the settings switch", err);
  } finally {
    syncingSettingsSection = false;
  }
}

function setEnabled(value, { writeSetting = false } = {}) {
  settings.enabled = Boolean(value);
  if (writeSetting) writeEnabledSetting(settings.enabled);
  getGame()?.scheduleSave?.();
  applyTakeover();
  if (!settings.enabled) endJob("stopped: automation is off");
  updatePanel();
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

function bankEntryItem(entry) {
  return entry?.item ?? entry;
}

function matchingBankItems(bank, predicate) {
  return bank
    .filterItems((entry) => predicate(bankEntryItem(entry), entry))
    .map(bankEntryItem)
    .filter((item) => item !== undefined);
}

// Every enchanted item in the bank at or below `grade`, locked ones left alone.
function disenchantTargets(ench, grade) {
  const bank = getBank();
  if (!bank || grade < 0) return [];
  return matchingBankItems(
    bank,
    (item) =>
      ench.isAugmentedItem(item) &&
      qualityOf(item) <= grade &&
      !bank.lockedItems.has(item),
  );
}

// Every bank item that could be enchanted at least one more grade towards `target`. Plain
// equipment counts (an enchant turns it into a grade-1 item); locked items never do.
function enchantTargets(ench, target) {
  const bank = getBank();
  if (!bank) return [];
  return matchingBankItems(bank, (item) => {
    if (bank.lockedItems.has(item)) return false;
    if (!ench.isAugmentedItem(item) && !ench.canAugmentItem(item)) return false;
    return qualityOf(item) < Math.min(target, MAX_QUALITY);
  });
}

// Enchanted items with at least one modifier slot are the only things worth rerolling.
function rerollCandidates(ench) {
  const bank = getBank();
  if (!bank) return [];
  return matchingBankItems(
    bank,
    (item) =>
      ench.isAugmentedItem(item) &&
      item.extraModifiers?.size > 0 &&
      !bank.lockedItems.has(item),
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
// would burn the rest of the stack up to grade 1 instead of walking one item to the target.
// So an enchant job takes the decision back after every single action.
function patchAction(proto) {
  const original = proto?.action;
  if (typeof original !== "function" || original[PATCH_FLAG]) return;

  const patched = function (...args) {
    const result = original.apply(this, args);
    try {
      if (job?.type === "enchant") {
        // Synchronous: createEnchantingItem ran inside the action we just let finish, so
        // nothing else can have created an item in between.
        job.produced = lastCreated;
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

function installPatches(ench) {
  const proto = Object.getPrototypeOf(ench);
  if (!proto) return;

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

  patchItemCreation(proto);
  patchAction(proto);
}

// ---------------------------------------------------------------------------
// Jobs
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
  job = null;
  if (driver) {
    clearInterval(driver);
    driver = null;
  }
  setStatus(reason);
  updatePanel();
}

// Enchant and Disenchant claim game.activeAction. Calling start() while combat or another
// skill owns it would pop the game's own "stop what you're doing?" modal at you, so we check
// first and never get there.
function skillSlotFree(ench) {
  const active = getGame()?.activeAction;
  return active === undefined || active === ench;
}

// Mirrors what clicking an action icon, then an item, then the big button does — minus the
// toggle behaviour of actionButtonOnClick(), which would *stop* a running action.
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
    switch (job.type) {
      case "disenchant":
        driveDisenchant(ench);
        break;
      case "enchant":
        driveEnchant(ench);
        break;
      case "reroll":
        driveReroll(ench);
        break;
      default:
        endJob("idle");
    }
  } catch (err) {
    console.error(`${TAG} job failed`, err);
    endJob("stopped: something went wrong (see the console)");
  }
}

// --- Disenchant ------------------------------------------------------------

function startDisenchantJob() {
  const ench = getEnchanting();
  if (!ench) return;
  if (settings.bankDisenchantGrade < 0) {
    setStatus("pick a grade to disenchant first");
    return;
  }
  const instant = settings.bankDisenchantMode === "instant";
  const count = disenchantTargets(ench, settings.bankDisenchantGrade).length;
  if (!count) {
    setStatus("nothing in the bank at that grade or below");
    return;
  }
  beginJob(
    { type: "disenchant", grade: settings.bankDisenchantGrade, instant, done: 0 },
    `disenchanting ${count} stack${count === 1 ? "" : "s"} of ${qualityName(settings.bankDisenchantGrade)} or below`,
  );
}

function driveDisenchant(ench) {
  if (job.instant) {
    driveInstantDisenchant(ench);
    return;
  }

  if (!skillSlotFree(ench)) {
    endJob("stopped: another skill or combat is using the action slot");
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
    endJob(`stopped: could not disenchant ${next.name}`);
    return;
  }
  job.done += 1;
  setStatus(`disenchanting ${next.name} — ${remaining.length} stack${remaining.length === 1 ? "" : "s"} left`);
}

function driveInstantDisenchant(ench) {
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

// --- Enchant ---------------------------------------------------------------

function startEnchantJob(pickedItem) {
  const ench = getEnchanting();
  if (!ench) return;

  const target = Math.min(settings.enchantTarget, MAX_QUALITY);
  if (target < 1) {
    setStatus("pick a grade to enchant up to first");
    return;
  }

  const single = settings.enchantScope === "single";
  if (single && !pickedItem) {
    setStatus("pick an item to enchant first");
    return;
  }
  if (!single && !enchantTargets(ench, target).length) {
    setStatus(`nothing in the bank below ${qualityName(target)}`);
    return;
  }

  beginJob(
    { type: "enchant", target, single, item: single ? pickedItem : null, produced: null, done: 0 },
    `enchanting up to ${qualityName(target)}`,
  );
}

function driveEnchant(ench) {
  if (!skillSlotFree(ench)) {
    endJob("stopped: another skill or combat is using the action slot");
    return;
  }
  if (ench.isActive) return; // an enchant is running; the action hook will take it from here

  const item = job.item ?? enchantTargets(ench, job.target)[0];
  if (!item) {
    endJob(`done: enchanted ${job.done} item${job.done === 1 ? "" : "s"} to ${qualityName(job.target)}`);
    return;
  }

  if (qualityOf(item) >= job.target) {
    job.done += 1;
    if (job.single) {
      endJob(`done: ${item.name} is ${qualityName(job.target)}`);
      return;
    }
    job.item = null; // that one's finished; the next tick picks another
    return;
  }

  if (isLocked(item)) {
    endJob(`stopped: ${item.name} is locked`);
    return;
  }

  const costs = ench.getEnchantCosts(item);
  if (ench.isCostEmpty(costs)) {
    endJob(`stopped: ${item.name} can't be enchanted any further`);
    return;
  }
  if (!costs.checkIfOwned()) {
    endJob("stopped: not enough essence for the next enchant");
    return;
  }
  if (belowEssenceFloor(costs)) {
    endJob(`stopped: the next enchant would take an essence below your floor of ${settings.essenceFloor}`);
    return;
  }

  if (!startSkillAction(ench, ENCHANT, item)) {
    endJob(`stopped: could not enchant ${item.name}`);
    return;
  }
  job.item = item;
  setStatus(`enchanting ${item.name} → ${qualityName(qualityOf(item) + 1)}`);
}

// Runs a macrotask after each completed enchant. The mod has already restarted itself on the
// old item by now, so stop it — nothing is lost, since an action's costs are consumed only
// when it finishes — and carry on with the item it just made.
function onEnchantActionDone() {
  if (job?.type !== "enchant") return;

  const ench = getEnchanting();
  if (!ench) return;

  try {
    if (ench.isActive) ench.stop();
  } catch (err) {
    warn("could not stop the Enchanting skill", err);
  }

  const previous = job.item;
  const produced = job.produced;
  job.produced = null;

  // Only follow the new item if it really is the old one, one grade up.
  const followsOn =
    produced &&
    ench.isAugmentedItem(produced) &&
    produced.item === (previous?.item ?? previous) &&
    qualityOf(produced) === qualityOf(previous) + 1;

  job.item = followsOn ? produced : null;

  if (job.single && !followsOn) {
    endJob("stopped: lost track of the item after the enchant");
    return;
  }

  driveJob();
}

// --- Reroll ----------------------------------------------------------------

function startRerollJob(pickedItem) {
  const ench = getEnchanting();
  if (!ench) return;

  if (!pickedItem || !ench.isAugmentedItem(pickedItem)) {
    setStatus("pick an enchanted item to reroll first");
    return;
  }

  const targets = new Set(
    settings.rerollTargetModIDs.map((id) => modByID(ench, id)).filter((mod) => mod !== undefined),
  );
  if (!targets.size) {
    setStatus("pick at least one modifier you want");
    return;
  }
  if (targets.size > pickedItem.extraModifiers.size) {
    setStatus(
      `${pickedItem.name} has only ${pickedItem.extraModifiers.size} modifier slot${
        pickedItem.extraModifiers.size === 1 ? "" : "s"
      } — you asked for ${targets.size}`,
    );
    return;
  }

  beginJob(
    { type: "reroll", item: pickedItem, targets, count: 0, max: settings.rerollMax },
    `rerolling ${pickedItem.name}`,
  );
}

function driveReroll(ench) {
  for (let i = 0; i < REROLL_BATCH; i += 1) {
    if (!rerollStep(ench)) return;
  }
  setStatus(`rerolling ${job.item.name} (${job.count}/${job.max})`);
}

// One reroll, or a reason to stop. Returns false once the job is over.
function rerollStep(ench) {
  const item = job.item;
  const bank = getBank();

  if (!item || bank.getQty(item) <= 0) {
    endJob("stopped: the item is no longer in the bank");
    return false;
  }
  if (isLocked(item)) {
    endJob(`stopped: ${item.name} is locked`);
    return false;
  }

  // Done as soon as every modifier you asked for is on the item — the others can be anything.
  const missing = [...job.targets].filter((mod) => !item.extraModifiers.has(mod));
  if (!missing.length) {
    endJob(`done: ${item.name} has every modifier you wanted (${job.count} reroll${job.count === 1 ? "" : "s"})`);
    return false;
  }

  // Only ever reroll a slot holding something you didn't ask for. A reroll can't hand back a
  // modifier the item already has, so the ones you wanted are never at risk.
  const slot = [...item.extraModifiers].find((mod) => !job.targets.has(mod));
  if (!slot) {
    endJob(`stopped: no slot left to reroll — ${item.name} can't hold all of those modifiers`);
    return false;
  }

  if (job.count >= job.max) {
    endJob(`stopped: hit the ${job.max}-reroll cap (${missing.length} still missing)`);
    return false;
  }

  const next = rerollSlot(ench, item, slot);
  if (!next) {
    endJob("stopped: could not reroll (out of essence, or the bank is full)");
    return false;
  }

  job.item = next;
  job.count += 1;
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
const parts = {}; // the live nodes updatePanel() refreshes
const itemTokens = new WeakMap();
let nextItemToken = 1;

function itemToken(item) {
  let token = itemTokens.get(item);
  if (!token) {
    token = `item-${nextItemToken}`;
    nextItemToken += 1;
    itemTokens.set(item, token);
  }
  return token;
}

function itemFromSelect(select, currentItems) {
  return select?.__items?.get(select.value) ?? findInBank(currentItems, select?.value);
}

function formatModifierName(mod) {
  const raw = String(mod?.name ?? mod?.localID ?? mod?.id ?? "");
  const local = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
  const spaced = local
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : raw;
}

function injectStyles() {
  if (document.getElementById(`${MARK}-styles`)) return;
  const style = document.createElement("style");
  style.id = `${MARK}-styles`;
  style.textContent = `
    .${MARK}-hidden { display: none !important; }
    .${MARK}-panel { margin-bottom: 1rem; }
    .${MARK}-row { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; padding: .5rem 0; }
    .${MARK}-row + .${MARK}-row { border-top: 1px solid rgba(128,128,128,.2); }
    .${MARK}-row > h4 { flex: 0 0 100%; margin: 0 0 .25rem; font-size: .9rem; font-weight: 600; }
    .${MARK}-panel label { margin: 0; font-weight: 400; cursor: pointer; }
    .${MARK}-panel select, .${MARK}-panel input[type=number] { max-width: 16rem; display: inline-block; }
    .${MARK}-mods { max-height: 8rem; min-width: 16rem; }
    .${MARK}-note { opacity: .6; font-size: .8em; }
    .${MARK}-status { margin-top: .5rem; font-size: .875rem; opacity: .75; }
  `;
  document.head.append(style);
}

function checkbox(key, label) {
  const wrap = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(settings[key]);
  input.addEventListener("change", () => {
    if (key === "enabled") {
      setEnabled(input.checked, { writeSetting: true });
      return;
    }
    settings[key] = input.checked;
    saveSettings();
    updatePanel();
  });
  wrap.append(input, document.createTextNode(` ${label}`));
  parts[key] = input;
  return wrap;
}

function gradeSelect(key, { includeOff = true, from = 0 } = {}) {
  const select = document.createElement("select");
  select.className = "form-control form-control-sm";
  if (includeOff) {
    const off = document.createElement("option");
    off.value = String(OFF);
    off.textContent = "Off";
    select.append(off);
  }
  for (let quality = from; quality <= MAX_QUALITY; quality += 1) {
    const option = document.createElement("option");
    option.value = String(quality);
    option.textContent = QUALITIES[quality];
    select.append(option);
  }
  select.value = String(settings[key]);
  select.addEventListener("change", () => {
    settings[key] = Number(select.value);
    saveSettings();
    updatePanel();
  });
  return select;
}

function labelled(text, node) {
  const label = document.createElement("label");
  label.append(document.createTextNode(`${text} `), node);
  return label;
}

function numberInput(key, { min = 0 } = {}) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "form-control form-control-sm";
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

function itemSelect() {
  const select = document.createElement("select");
  select.className = "form-control form-control-sm";
  select.__options = null; // not "" — an empty bank is a real list, and must still render
  select.__items = new Map();
  return select;
}

// Rebuilds an item dropdown only when the set of items in it actually changes, so it can be
// refreshed on a timer without snatching the list out from under a click.
function refreshItemSelect(select, items, placeholder) {
  const entries = items.map((item) => [itemToken(item), item]);
  const key = entries.map(([token]) => token).join(",");
  if (select.__options === key) return;
  select.__options = key;
  select.__items = new Map(entries);

  const previous = select.value;
  select.replaceChildren();

  const none = document.createElement("option");
  none.value = "";
  none.textContent = placeholder;
  select.append(none);

  const bank = getBank();
  for (const [token, item] of entries) {
    const option = document.createElement("option");
    option.value = token;
    option.textContent = `${item.name} (${bank?.getQty?.(item) ?? 0})`;
    select.append(option);
  }
  select.value = select.__items.has(previous) ? previous : "";
}

function startStop(onStart, jobType) {
  const button = document.createElement("button");
  button.className = "btn btn-sm btn-success";
  button.textContent = "Start";
  button.addEventListener("click", () => {
    if (job?.type === jobType) endJob("stopped");
    else onStart();
  });
  return button;
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.className = `block block-rounded ${MARK}-panel`;

  const header = document.createElement("div");
  header.className = "block-header block-header-default";
  const title = document.createElement("h3");
  title.className = "block-title";
  title.textContent = "Auto Enchanting";
  header.append(title, checkbox("enabled", "Automation enabled"));

  const content = document.createElement("div");
  content.className = "block-content";

  content.append(buildLootRow(), buildDisenchantRow(), buildEnchantRow(), buildRerollRow());

  const status = document.createElement("div");
  status.className = `${MARK}-status`;
  parts.status = status;
  content.append(status);

  panel.append(header, content);
  return panel;
}

function buildLootRow() {
  const row = document.createElement("div");
  row.className = `${MARK}-row`;

  const heading = document.createElement("h4");
  heading.textContent = "Auto-disenchant new loot";
  row.append(heading);

  row.append(
    labelled("Crafting rewards:", gradeSelect("autoDisenchantRewards")),
    checkbox("includeCommonRewards", "Include Common"),
    checkbox("downgradeRewards", "Downgrade"),
  );
  row.append(
    labelled("Other drops:", gradeSelect("autoDisenchantDrops")),
    checkbox("includeCommonDrops", "Include Common"),
    checkbox("downgradeDrops", "Downgrade"),
  );

  const note = document.createElement("span");
  note.className = `${MARK}-note`;
  note.textContent = "Replaces the Enchanting mod's own auto-disenchant (half XP, as before).";
  row.append(note);
  return row;
}

function buildDisenchantRow() {
  const row = document.createElement("div");
  row.className = `${MARK}-row`;

  const heading = document.createElement("h4");
  heading.textContent = "Disenchant the bank";
  row.append(heading);

  const mode = document.createElement("select");
  mode.className = "form-control form-control-sm";
  for (const [value, text] of [
    ["skill", "Use the skill (full XP)"],
    ["instant", "Instant (half XP)"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    mode.append(option);
  }
  mode.value = settings.bankDisenchantMode;
  mode.addEventListener("change", () => {
    settings.bankDisenchantMode = mode.value;
    saveSettings();
    updatePanel();
  });

  const count = document.createElement("span");
  count.className = `${MARK}-note`;
  parts.disenchantCount = count;

  const button = startStop(startDisenchantJob, "disenchant");
  parts.disenchantButton = button;

  row.append(
    labelled("Grade and below:", gradeSelect("bankDisenchantGrade")),
    labelled("Mode:", mode),
    button,
    count,
  );
  return row;
}

function buildEnchantRow() {
  const row = document.createElement("div");
  row.className = `${MARK}-row`;

  const heading = document.createElement("h4");
  heading.textContent = "Enchant until";
  row.append(heading);

  const scope = document.createElement("select");
  scope.className = "form-control form-control-sm";
  for (const [value, text] of [
    ["single", "One item"],
    ["all", "Everything eligible"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    scope.append(option);
  }
  scope.value = settings.enchantScope;
  scope.addEventListener("change", () => {
    settings.enchantScope = scope.value;
    saveSettings();
    updatePanel();
  });

  const picker = itemSelect();
  parts.enchantItem = picker;

  const button = startStop(() => startEnchantJob(pickedEnchantItem()), "enchant");
  parts.enchantButton = button;

  row.append(
    labelled("Grade:", gradeSelect("enchantTarget", { includeOff: false, from: 1 })),
    labelled("Scope:", scope),
    labelled("Item:", picker),
    labelled("Keep essence above:", numberInput("essenceFloor")),
    button,
  );
  return row;
}

function buildRerollRow() {
  const row = document.createElement("div");
  row.className = `${MARK}-row`;

  const heading = document.createElement("h4");
  heading.textContent = "Reroll until";
  row.append(heading);

  const picker = itemSelect();
  picker.addEventListener("change", () => updateModList());
  parts.rerollItem = picker;

  const mods = document.createElement("select");
  mods.className = `form-control form-control-sm ${MARK}-mods`;
  mods.multiple = true;
  mods.addEventListener("change", () => {
    settings.rerollTargetModIDs = [...mods.selectedOptions].map((option) => option.value);
    saveSettings();
  });
  parts.rerollMods = mods;

  const button = startStop(() => startRerollJob(pickedRerollItem()), "reroll");
  parts.rerollButton = button;

  const note = document.createElement("span");
  note.className = `${MARK}-note`;
  note.textContent = "Stops as soon as every modifier you picked is on the item.";

  row.append(
    labelled("Item:", picker),
    labelled("Modifiers you want:", mods),
    labelled("Reroll cap:", numberInput("rerollMax", { min: 1 })),
    button,
    note,
  );
  return row;
}

function pickedEnchantItem() {
  const ench = getEnchanting();
  if (!ench) return undefined;
  const items = enchantTargets(ench, Math.min(settings.enchantTarget, MAX_QUALITY));
  return itemFromSelect(parts.enchantItem, items);
}

function pickedRerollItem() {
  const ench = getEnchanting();
  if (!ench) return undefined;
  const items = rerollCandidates(ench);
  return itemFromSelect(parts.rerollItem, items);
}

// The modifiers on offer depend on the item: its base type, its grade, and your skill level.
function updateModList() {
  const ench = getEnchanting();
  const select = parts.rerollMods;
  if (!ench || !select) return;

  const item = pickedRerollItem();
  const pool = item ? ench.getPossibleMods(item.item, item.quality) : [];
  const key = pool.map((mod) => mod.id).join(",");
  if (select.__options === key) return;
  select.__options = key;

  select.replaceChildren();
  for (const mod of pool) {
    const option = document.createElement("option");
    option.value = mod.id;
    option.textContent = formatModifierName(mod);
    option.selected = settings.rerollTargetModIDs.includes(mod.id);
    select.append(option);
  }
}

function updatePanel() {
  if (!panelEl) return;
  const ench = getEnchanting();
  if (!ench) return;

  const running = Boolean(job);

  if (parts.enabled) parts.enabled.checked = settings.enabled;

  const disenchantable = disenchantTargets(ench, settings.bankDisenchantGrade).length;
  if (parts.disenchantCount) {
    parts.disenchantCount.textContent =
      settings.bankDisenchantGrade < 0
        ? "pick a grade"
        : `${disenchantable} stack${disenchantable === 1 ? "" : "s"} match`;
  }

  refreshItemSelect(
    parts.enchantItem,
    enchantTargets(ench, Math.min(settings.enchantTarget, MAX_QUALITY)),
    "— pick an item —",
  );
  parts.enchantItem.disabled = settings.enchantScope !== "single";

  refreshItemSelect(parts.rerollItem, rerollCandidates(ench), "— pick an item —");
  updateModList();

  for (const [type, button] of [
    ["disenchant", parts.disenchantButton],
    ["enchant", parts.enchantButton],
    ["reroll", parts.rerollButton],
  ]) {
    if (!button) continue;
    const isThisJob = job?.type === type;
    button.textContent = isThisJob ? "Stop" : "Start";
    button.className = `btn btn-sm ${isThisJob ? "btn-danger" : "btn-success"}`;
    // One job at a time: they compete for the skill's action slot, or for the item itself.
    button.disabled = !settings.enabled || (running && !isThisJob);
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
        if (syncingSettingsSection) return;
        setEnabled(value);
      },
    });
    settings.enabled = readEnabledSetting(settings.enabled);
  } catch (err) {
    warn("could not register settings section", err);
  }
}

// Mod Settings are per-character and persisted by the game. Keep `enabled` there instead of
// duplicating it in characterStorage, otherwise the two stores can overwrite each other during
// load. The rest of the panel-only settings stay in characterStorage.
function syncSettingsSection() {
  settings.enabled = readEnabledSetting(settings.enabled);
}

// ---------------------------------------------------------------------------

export function setup(ctx) {
  registerSettings(ctx);

  ctx.onCharacterLoaded((loadedCtx = ctx) => {
    storage = loadedCtx.characterStorage ?? ctx.characterStorage ?? storage;
    loadSettings();
    syncSettingsSection();
  });

  ctx.onInterfaceReady((readyCtx = ctx) => {
    const ench = getEnchanting();
    if (!ench) {
      warn("game.enchanting not found — is the Enchanting mod installed and enabled? Doing nothing.");
      return;
    }

    // A mod reloaded into a running game misses onCharacterLoaded, so settings would still be
    // at their defaults here. Load them if that hook never ran.
    if (!storage) storage = readyCtx.characterStorage ?? ctx.characterStorage ?? storage;
    if (!settingsLoaded) {
      loadSettings();
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
      save: () => {
        writeEnabledSetting(settings.enabled);
        saveSettings();
        getGame()?.scheduleSave?.();
      },
      stop: () => endJob("stopped by hand"),
      dump() {
        console.log({ live: settings, stored: this.stored(), hasStorage: !!storage, job });
      },
      reset() {
        settings = structuredClone(DEFAULTS);
        writeEnabledSetting(settings.enabled);
        saveSettings();
        applyTakeover();
        updatePanel();
      },
    };

    log(`Loaded. ${ench.equipment?.size ?? 0} enchanted items known, ${ench.mods?.size ?? 0} modifiers.`);
  });
}
