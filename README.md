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
| **Enchant until** | manual start | Enchants one selected item, or every eligible unlocked bank item, up to the target grade. **Spends the item plus essence costs until the target or essence floor stops it.** |
| **Keep essence above** | 0 | Hard floor for enchanting costs; the next enchant is refused if any essence would drop below this. |
| **Reroll until** | manual start | Rerolls one selected enchanted item until every selected modifier appears. **Spends grade essence up to the reroll cap.** |
| **Reroll cap** | 500 | Maximum attempts for a reroll job. |

Locked items are always skipped. Only one bank job runs at a time, and every spending job is
started by hand from the panel.

## How It Works

Controls live in a panel on the Enchanting page, just under the XP bars.

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
because the original `executeReroll()` reads the slot from a DOM radio button.

## Install

**From a modfile:** install `auto-enchanting.zip` (contains `manifest.json` + `setup.mjs` at the
archive root).

**As a local mod:** create a local mod in the Melvor Mod Manager and point it at the `mod/`
folder. For settings/storage persistence, Melvor's modding wiki says local mods loaded through
the Creator Toolkit must also be linked to mod.io and subscribed/installed through mod.io.

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
- **The master switch lives in Mod Settings.** The wiki says Mod Settings are saved per
  character in the character's save file, so `enabled` is not duplicated into
  `characterStorage`.
- **Panel-only settings live in per-character `characterStorage["settings"]`.** The storage
  handle is taken from the `onCharacterLoaded`/`onInterfaceReady` callback context because the
  wiki says character storage is not available until a character has loaded. `saveSettings()`
  schedules a game save so changes survive a reload before the next autosave.
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
