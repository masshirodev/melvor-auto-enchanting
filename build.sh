#!/usr/bin/env bash
#
# Packages the mod into auto-enchanting-v<version>.zip for upload to mod.io / the Mod Manager.
#
# manifest.json and setup.mjs must sit at the ROOT of the archive, not inside a mod/
# folder. Melvor can install a wrongly nested mod without running it, so `zip -j` is
# intentional and the final archive layout is verified.

set -euo pipefail
cd "$(dirname "$0")"

FILES=(mod/manifest.json mod/setup.mjs)

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
done

node --check mod/setup.mjs
node -e 'JSON.parse(require("fs").readFileSync("mod/manifest.json"))'

if [[ "${1:-}" != "--skip-tests" ]]; then
  node test/engine.test.mjs
fi

VERSION=$(node -pe 'require("./mod/manifest.json").version')
OUT="auto-enchanting-v$VERSION.zip"

rm -f "$OUT"
zip -j -q "$OUT" "${FILES[@]}"

contents=$(unzip -Z1 "$OUT" | sort | tr '\n' ' ')
expected="manifest.json setup.mjs "
if [[ "$contents" != "$expected" ]]; then
  echo "unexpected archive layout: $contents" >&2
  echo "expected files at the archive root, got the above" >&2
  exit 1
fi

echo "built $OUT (v$VERSION)"
unzip -l "$OUT" | sed -n '4,5p'
