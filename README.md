# Auto Enchanting

A Melvor Idle companion mod for the third-party **Enchanting** mod.

The Enchanting mod can auto-disenchant newly obtained loot, but it does not help with the
enchanted items already sitting in your bank, and all enchanting/rerolling is one item at a
time. Auto Enchanting puts those workflows on the Enchanting page: bulk bank disenchant,
enchant until a target grade, reroll until selected modifiers appear, and one unified
auto-disenchant panel for new loot.

**Requires the Enchanting mod.** Without it, Auto Enchanting logs a warning and does nothing.

## Features

| Setting | Default | What it does |
| --- | --- | --- |
| **Automation enabled** | off | Master switch. When on, the native Enchanting auto-disenchant UI is hidden and controlled here. |
| **Auto-disenchant new loot** | off | Replaces the Enchanting mod's auto-disenchant for crafting rewards and other drops. Same half-XP behavior as the original. |
| **Disenchant the bank** | off | Disenchants all unlocked enchanted bank stacks at or below a chosen grade. **Spends the item stacks you selected by grade.** |
| **Bank disenchant mode** | skill | `Use the skill` gives full XP and uses the Enchanting action slot. `Instant` gives half XP and does not use the action slot. |
| **Task queue** | empty | Enchant and reroll jobs are queued per item: pick an item, set the goal, press **Add**. **Start queue** works through them in order, one at a time. |
| **Keep essence above** | 0 | Hard floor across every task; a task fails rather than take an essence below this. |
| **Reroll cap** | 500 | How many rerolls a single task may pay for before giving up. |

Locked items are always skipped. Only one job runs at a time — the bank sweep and the queue both
want the skill's action slot — and every job that spends is started by hand from the panel.

## How It Works

Controls live in a panel on the Enchanting page, just under the XP bars.

**The queue.** An enchant or a reroll is a *task*: an item plus a goal ("up to Epic", "until it
has Increased Global Accuracy"). Adding one puts it in a list, and **Start queue** runs the list
top to bottom, marking each task done or failed with the reason. A task that fails — the item was
locked, the essence ran out, you asked for three modifiers on a two-slot item — doesn't stop the
rest of the queue. **Clear finished** tidies up.

Item dropdowns list everything eligible in the bank, alphabetically, with live quantities: they
refresh as you enchant and disenchant.

Auto Enchanting takes over the Enchanting mod's six native auto-disenchant fields while the
master switch is enabled, remembers their old values, forces the native feature off, and hides
the native row. Turning Auto Enchanting off restores those fields.

Bank disenchant has two modes:

- **Use the skill (full XP):** selects the Enchanting mod's Disenchant action and lets the skill
  drain each matching stack normally. It refuses to run if another skill or combat owns the
  action slot.
- **Instant (half XP):** mirrors the Enchanting mod's own loot auto-disenchant reward path, but
  applies it to existing bank stacks. It removes the item first so the freed bank slot can hold
  the essence.

Enchanting uses the real Enchant action. The mod stops after each completed action and follows
the newly created item object to the next grade, instead of letting the Enchanting mod keep
rerunning on the same selected item.

Rerolling reimplements the Enchanting mod's instant reroll path with an explicit modifier slot,
because the original `executeReroll()` reads the slot from a DOM radio button. It only ever
rerolls a slot holding a modifier you *didn't* ask for, and a reroll can't hand back a modifier
the item already has — so the ones you wanted are never at risk. A partial ask is fine: name one
modifier on a three-slot item and the task is done the moment that one appears.

## Install

**From a modfile:** install `auto-enchanting.zip` (contains `manifest.json` + `setup.mjs` at the
archive root).

**As a local mod:** create a local mod in the Melvor Mod Manager and point it at the `mod/`
folder.

> **Settings will not persist for an unlinked local mod.** Melvor's wiki says this of both Mod
> Settings and character storage: *"When loading your mod as a Local Mod via the Creator Toolkit,
> the mod must be linked to mod.io and you must have subscribed to and installed the mod via
> mod.io in order for this data to persist."* Nothing is saved until you do — no amount of code
> here can change that. The mod says so in the console at load; run `autoEnchanting.check()` to
> see for yourself.

Then enable it alongside the Enchanting mod and load a character.

## Development Notes

Everything lives in `mod/setup.mjs`. The Enchanting mod's API was recovered from its zip and
confirmed with `probes/probe1.js`; probe first when changing a runtime assumption.

Things worth knowing before changing this:

- **`manifest.json` is the required filename.** A wrongly named manifest installs but never runs.
- **Melvor's globals are lexically scoped**, not always on `globalThis`. Use the guarded helpers
  in `mod/setup.mjs` (`getGame()`, `getEnchanting()`, and friends).
- **The skill instance is `game.enchanting`**. Enchanted items are separate item objects with
  `.item` pointing to the base item, `.quality` holding the grade, and `.extraModifiers` holding
  the rolled modifiers.
- **Grades are integers:** 0 Common, 1 Uncommon, 2 Rare, 3 Epic, 4 Legendary, 5 Mythic.
- **Locked items are `game.bank.lockedItems`**, a `Set<Item>`, and all bulk operations check it.
- **Do not use speculative `getObjectByID()` lookups for stale `enchanting:` ids.** The
  Enchanting mod can fabricate and register dummy objects for unresolved ids. Resolve saved ids
  by scanning existing `allObjects` or bank items.
- **All settings, `enabled` included, live in per-character `characterStorage["settings"]`.** The
  Mod Settings switch is a *mirror*, pushed back with `.set()` on character load so it can't show
  you the previous character's state — the same arrangement auto-sailing uses. `characterStorage`
  is the single source of truth, so the two cannot fight.
- **Take the storage handle in `setup()`, not in `onCharacterLoaded`.** The object exists from
  setup; only its *contents* need a loaded character. A mod reloaded into an already-running game
  never gets that hook, and every `setItem` then silently no-ops.
- **`saveSettings()` must call `game.scheduleSave()`.** `characterStorage` only reaches the save
  file when the game next saves, so without it a toggle followed by a reload is simply lost. It
  also tolerates a JSON *string* coming back on read: spreading a string yields numeric keys and
  leaves every real setting at its default, which looks exactly like "settings didn't save".
- **`Bank.filterItems(pred)` hands `pred` a BankItem.** What it *returns* is the plain Item — that
  is how the Enchanting mod itself uses it — but bank-entry records have been reported coming
  back instead. `unwrap()` copes with either, keyed on `.quantity`, because an enchanted item
  also has an `.item` (its base) and the two would otherwise be indistinguishable.
- The `probes/` directory holds console scripts used to confirm the skill object graph at
  runtime. Paste them into the browser console with the Enchanting page open.

## Build

```sh
./build.sh              # syntax-check, run tests, package auto-enchanting.zip
./build.sh --skip-tests
```

`manifest.json` and `setup.mjs` must end up at the root of the archive. The script uses `zip -j`
and verifies the final layout.

## Tests

```sh
node test/engine.test.mjs
```

The test drives the real `mod/setup.mjs` against a fake Melvor game and fake Enchanting skill.
It covers the takeover, loot replacement, both bank disenchant modes, enchant-to-grade,
essence-floor guard, reroll cap/target behavior, locked-item skipping, and persistence.

## Known Limits

The mod only runs while the game is open. It does not simulate missed enchants, rerolls, or
disenchants while offline.

The Enchanting mod can change its internal API. If a future version renames `game.enchanting`,
changes item fields, or changes `replaceDrop()` / `replaceRewards()`, run `probes/probe1.js`
against that version before updating the automation.
