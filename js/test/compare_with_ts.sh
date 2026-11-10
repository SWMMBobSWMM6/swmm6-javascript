#!/bin/bash
# compare_with_ts.sh - the syntax trees of the JavaScript port's engine, runtime, math and command line against the
# JavaScript tsc wrote for the TypeScript port (ts/dist, made by ts/build.sh), file for file (compare_ast.mjs: acorn's
# trees, positions, comments, parentheses and the spelling of literals aside). Needs ts/dist; writes nothing.
# Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see ../README.md.
set -e
J=$(cd "$(dirname "$0")/.." && pwd); ROOT=$(cd "$J/.." && pwd)
D=$ROOT/ts/dist
[ -f "$D/gen/engine.js" ] || { echo "no ts/dist: build the TypeScript port first (ts/build.sh)"; exit 2; }
echo "ts/dist built $(date -r "$D/gen/engine.js" -Is) from ts/gen/engine.ts (md5 $(md5sum < "$ROOT/ts/gen/engine.ts" | cut -c1-32)) and ts/src"
pairs=("$J/gen/engine.js" "$D/gen/engine.js")
for f in $(cd "$J/src" && find . -name '*.js' | sort); do pairs+=("$J/src/${f#./}" "$D/src/${f#./}"); done
node --max-old-space-size=4096 "$J/test/compare_ast.mjs" "${pairs[@]}" | sed "s#$ROOT/##g"
