// Auto Enchanting - probe 1: the Enchanting skill object graph.
//
// Run it with the ENCHANTING PAGE OPEN, in the browser console.
// (Melvor requires you to type `allow pasting` in the console once first.)
//
// Confirms every runtime assumption auto-enchanting relies on:
//   - game.enchanting exists
//   - actions/mods/equipment registries are present
//   - native auto-disenchant fields and menu row exist
//   - locked items are game.bank.lockedItems
//   - replaceDrop/replaceRewards/createEnchantingItem/action helpers are callable

(() => {
  const lines = [];
  const p = (...args) => lines.push(args.join(" "));

  const enchanting = game.enchanting;
  if (!enchanting) {
    console.warn("game.enchanting is undefined - is the Enchanting mod installed and enabled?");
    return "no enchanting skill";
  }

  const fn = (value) => (typeof value === "function" ? "function" : typeof value);
  const registryInfo = (name) => {
    const reg = enchanting[name];
    return `${name}:${reg?.size ?? reg?.allObjects?.length ?? "MISSING"}`;
  };

  p("===== SKILL =====");
  p("  id              =", enchanting.id);
  p("  ctor            =", enchanting.constructor?.name);
  p("  level           =", enchanting.level);
  p("  maxQuality      =", enchanting.maxQuality);
  p("  isActive        =", enchanting.isActive);
  p("  selectedAction  =", enchanting.selectedAction?.id);
  p("  selectedItem    =", enchanting.selectedItem?.id);
  p("  currentAction   =", enchanting.currentAction?.id);
  p("  registries      =", ["actions", "equipment", "mods"].map(registryInfo).join(" "));

  p("");
  p("===== METHODS =====");
  for (const name of [
    "selectActionOnClick",
    "selectItemOnClick",
    "start",
    "stop",
    "action",
    "getCurrentActionCosts",
    "isCostEmpty",
    "getEnchantCosts",
    "getRerollCosts",
    "getEssenceForItem",
    "getItemLevelMultiplier",
    "isAugmentedItem",
    "canAugmentItem",
    "createEnchantingItem",
    "getPossibleMods",
    "modCount",
    "replaceDrop",
    "replaceRewards",
    "giveAutoDisenchantRewards",
  ]) {
    p(`  ${name.padEnd(28)} =`, fn(enchanting[name]));
  }

  p("");
  p("===== ACTIONS =====");
  for (const action of enchanting.actions?.allObjects ?? []) {
    p(
      `  ${action.id}`,
      "baseXP=",
      action.baseXP,
      "baseInterval=",
      action.baseInterval,
    );
  }

  p("");
  p("===== AUTO-DISENCHANT FIELDS =====");
  for (const key of [
    "autoDisenchantRewards",
    "autoDisenchantDrops",
    "includeCommonRewards",
    "includeCommonDrops",
    "downgradeRewards",
    "downgradeDrops",
  ]) {
    p(`  ${key.padEnd(24)} =`, enchanting[key]);
  }
  p("  menu.autoDisenchantRow =", Boolean(enchanting.menu?.autoDisenchantRow));
  p("  menu.localize          =", fn(enchanting.menu?.localize));

  p("");
  p("===== BANK / LOCKS =====");
  p("  game.bank                 =", Boolean(game.bank));
  p("  game.bank.lockedItems     =", game.bank?.lockedItems?.constructor?.name, "size", game.bank?.lockedItems?.size);
  p("  game.bank.filterItems     =", fn(game.bank?.filterItems));
  p("  game.bank.getQty          =", fn(game.bank?.getQty));
  p("  game.activeAction         =", game.activeAction?.id ?? game.activeAction?.name ?? game.activeAction);

  p("");
  p("===== SAMPLE BANK ITEMS =====");
  const samples = game.bank?.filterItems?.(() => true)?.slice?.(0, 20) ?? [];
  for (const bankItem of samples) {
    const item = bankItem.item;
    p(
      `  ${item?.id}`,
      `"${item?.name}"`,
      "qty=",
      bankItem.quantity ?? game.bank.getQty?.(item),
      "augmented=",
      enchanting.isAugmentedItem?.(item),
      "canAugment=",
      enchanting.canAugmentItem?.(item),
      "quality=",
      item?.quality ?? 0,
      "locked=",
      game.bank.lockedItems?.has?.(item),
      "mods=",
      [...(item?.extraModifiers ?? [])].map((mod) => mod.id).join(",") || "-",
    );
  }

  p("");
  p("===== MODIFIERS =====");
  for (const mod of enchanting.mods?.allObjects?.slice?.(0, 30) ?? []) {
    p(`  ${mod.id}`, `"${mod.name}"`, "quality=", mod.quality);
  }

  p("");
  p("===== DOM =====");
  const container = document.getElementById("enchanting-container");
  p("  #enchanting-container =", Boolean(container));
  p("  .skill-info           =", Boolean(container?.querySelector?.(".skill-info")));

  p("");
  p("===== SOURCE SNIPPETS =====");
  for (const name of ["replaceDrop", "replaceRewards", "createEnchantingItem", "action"]) {
    const source = String(enchanting[name] ?? "");
    p(`--- ${name} ---`);
    p(source.slice(0, 1200));
  }

  const text = lines.join("\n");
  console.log(text);
  copy(text);
  return "copied to clipboard";
})();
