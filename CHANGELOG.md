# Changelog

## 0.1.2 - A task queue, and a panel that reads like one

- **Enchant and reroll are now queued.** Pick an item, set the goal, press **Add**; the task
  joins a list. **Start queue** works through it top to bottom, marking each task done or failed
  with the reason. A task that fails doesn't take the rest of the queue down with it, and
  **Clear finished** tidies up. Replaces the old "configure one job, press Start" flow, which
  could only ever describe a single item at a time.
- **Rebuilt the panel.** Three labelled sections — loot, bank sweep, queue — with every control
  in a captioned box on the same baseline, instead of one long line of dropdowns.
- **Item dropdowns are alphabetical and live.** They were keyed on the *set* of item ids, so a
  quantity that changed while you enchanted or disenchanted never redrew and the list went stale.
  Now keyed on quantity too.
- **Modifier names are readable.** `increasedGlobalAccuracy` renders as `Increased Global
  Accuracy` when the modifier carries no display name of its own.
- **Fixed: stopping a task and starting it again failed the row.** Every enchant and every reroll
  replaces the item with a new object carrying a new id, but the task went on naming the item it
  started from — which by then had been consumed. A running task now moves its pointer to the
  item it actually holds, so Stop/Start resumes where it left off. The adoption happens
  synchronously inside the action hook, so even a Stop landing between an enchant completing and
  our callback running leaves the task pointing at an item that exists.
- **Fixed: the bank sweep refused to start while you were doing anything else.** It checked
  `game.activeAction` itself and gave up — so with combat running, "990 stacks match" turned into
  "stopped: another skill or combat is using the action slot" and nothing happened. Whether an
  Enchanting action may take the slot is the *game's* call, made by its own `idleChecker`, so we
  now just start it, exactly as if you had clicked the button. If the game turns us down, the job
  stops cleanly instead of retrying and stacking modals on you.
- **Says out loud when settings can't persist.** An unlinked local mod saves nothing — Melvor
  requires a local mod to be linked to mod.io and installed from there before any Mod Settings or
  character storage is written, and until then every `setItem` is silently dropped. The mod now
  round-trips a canary at load and warns with that explanation instead of looking broken.
  `autoEnchanting.check()` re-runs it on demand. The storage handle is also taken from the
  `onCharacterLoaded` context, as the docs show, and writes over Melvor's 8kb per-mod cap are
  refused with a warning rather than silently lost.
- **The bank may hand back records instead of items.** `filterItems()` is documented (by the
  Enchanting mod's own use of it) to return plain Items, but bank-entry records have been seen
  coming back. `unwrap()` copes with either — keyed on `.quantity`, since an enchanted item also
  has an `.item` and the two are otherwise indistinguishable.

## 0.1.1 - Persistence fix

- **Settings survive a reload.** `characterStorage` only reaches the save file when the game next
  saves, so `saveSettings()` now calls `game.scheduleSave()`. Without it, changing a setting and
  then reloading before the next autosave simply lost it — the whole "my settings don't persist"
  symptom.
- **The storage handle is taken in `setup()`, not in `onCharacterLoaded`.** The object exists from
  setup; only its *contents* need a loaded character. A mod reloaded into an already-running game
  never gets that hook, and every write was silently no-opping.
- **Reads tolerate a JSON string as well as an object.** Spreading a string yields an object with
  numeric keys and leaves every real setting at its default, which looks identical to a failed
  save.
- `characterStorage["settings"]` stays the single source of truth, `enabled` included; the Mod
  Settings switch is a mirror pushed back on character load, so the two can't fight.

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
