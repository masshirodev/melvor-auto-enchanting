# Changelog

## 0.1.2 - Picker and modifier display fixes

- Fixed the **Enchant until** item picker when Melvor returns bank-entry records from
  `bank.filterItems()` instead of raw item objects.
- Item dropdowns now keep the selected item object behind a stable option token, with id-based
  fallback only for stale/manual values.
- Reroll modifier names are formatted from ids such as `increasedGlobalAccurate` into readable
  labels such as `Increased Global Accurate`.

## 0.1.1 - Persistence fix

- **Fixed the master switch fighting characterStorage.** The Melvor modding wiki says Mod
  Settings are already persisted per character in the character save, so `enabled` now lives
  only in the Mod Settings switch instead of also being stored in `characterStorage`.
- **Fixed characterStorage timing.** The wiki says `characterStorage` is not available until a
  character has loaded, so the storage handle is now taken from the lifecycle callback context
  instead of assuming it exists during `setup()`.
- Character storage now only contains the richer panel settings (`autoDisenchant*`, bank
  disenchant mode/grade, enchant target/scope, essence floor, reroll targets/cap, and native
  Enchanting backup).
- The test harness now models Mod Settings and characterStorage as separate persistence stores.

## 0.1.0 - Initial release

Adds bulk automation for the Enchanting mod.

- **Takes over native auto-disenchant for new loot.** When enabled, Auto Enchanting snapshots the
  Enchanting mod's own drop/reward auto-disenchant settings, forces them off, hides that native
  row, and exposes equivalent controls in one panel. Turning the mod off restores the old native
  settings.
- **Adds bank disenchant by grade.** Disenchant every unlocked enchanted bank stack at or below a
  chosen grade. The skill mode uses the real Disenchant action for full XP; instant mode mirrors
  the native auto-disenchant path for half XP.
- **Adds enchant-until-target-grade jobs.** Enchant one selected item or sweep every eligible
  unlocked bank item up to a selected grade. The job stops before spending essence below the
  configured floor.
- **Adds reroll-until-modifier jobs.** Pick an enchanted item, choose the modifiers you want, and
  reroll until all selected modifiers are present or the reroll cap is reached.
- **Always skips locked items.** Bulk jobs check `game.bank.lockedItems` before touching a stack.
- **Settings persist per character** through `characterStorage["settings"]`, with an explicit
  `game.scheduleSave()` after writes.
- Includes a zero-dependency test harness: `node test/engine.test.mjs`.

### Notes from building it

- **The Enchanting mod's native auto-disenchant is not a Mod Manager setting.** It is six fields
  on `game.enchanting`, persisted inside the skill's own save data. Auto Enchanting has to
  snapshot and restore those fields directly.
- **Enchanted items are new item objects.** Enchanting does not mutate the original item; it
  creates a new object with `.item`, `.quality`, `.extraModifiers`, and `.extraSpecials`. The
  enchant job patches `createEnchantingItem()` so it can follow that new object to the next
  grade.
- **The Enchant action self-restarts on the same selected item.** Without stopping after each
  completed action, a stack of plain items would be pushed sideways into multiple Uncommon items
  instead of walking one item up to the target grade.
- **Reroll is instant but its original method is DOM-driven.** The Enchanting mod chooses the
  reroll slot by reading a radio button, so Auto Enchanting reimplements the same bank/cost
  sequence with an explicit slot argument.
- **Speculative `getObjectByID()` calls are unsafe for Enchanting ids.** The dependency mod can
  fabricate missing `enchanting:` objects. Saved modifier ids are resolved by scanning existing
  registries instead.
