#!/bin/bash
# make_runtime.sh - write the JavaScript runtime (src/cpp/*.js, src/cpp/libm/nan.js) and the command line (src/main.js)
# from the TypeScript port's (ts/src/cpp/*.ts, ts/src/main.ts) with js/tools/ts2js.mjs, which removes the types and
# changes nothing else (every line keeps its number; a note is added at the end of each file). The math is not made
# here: src/cpp/libm/glibm.js and glibm2.js come from tools/libm/gim2x.py's JavaScript back end and glibm_rt.js and
# glibm2_rt.js from tools/libm (make_glibm.sh). JS_OUT writes into another folder (default this port's src/).
# Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see js/README.md.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/.." && pwd)
O=${JS_OUT:-$HERE/src}
args=()
for f in "$ROOT"/ts/src/cpp/*.ts "$ROOT"/ts/src/cpp/libm/nan.ts "$ROOT"/ts/src/main.ts; do
	r=${f#"$ROOT"/ts/src/}
	args+=("$f" "$O/${r%.ts}.js")
done
node "$HERE/tools/ts2js.mjs" "${args[@]}"
for ((k = 0; k < ${#args[@]}; k += 2)); do
	r=${args[k]#"$ROOT"/}
	printf '// (%s without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)\n' "$r" >> "${args[k+1]}"
done
echo "wrote $(( ${#args[@]} / 2 )) files into $O"
