#!/bin/bash
# make_checks.sh - write the runtime check programs of js/test (rt/*.js, libm/*.js) from the TypeScript port's (tests/ and
# tools/libm/test), with js/tools/ts2js.mjs, which removes the types; the import of the runtime is then pointed at
# js/src/cpp (the only change besides the types; each file says so at its end). run_runtime_checks.sh and
# run_libm_tests.sh run them.
# Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see ../README.md.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd); T=$ROOT/tests
mk() {   # mk SOURCE OUT [OLD_IMPORT_PATH NEW_IMPORT_PATH]
	node "$ROOT/js/tools/ts2js.mjs" "$1" "$2"
	local note="${1#"$ROOT"/} without its TypeScript types, written by js/tools/ts2js.mjs"
	if [ $# -gt 2 ]; then
		grep -q "from '$3" "$2" || { echo "make_checks: no import of $3 in $2"; exit 1; }
		sed -i "s#from '$3#from '$4#" "$2"
		note="$note, its import of the runtime pointed at js/src/cpp"
	fi
	printf '// (%s; see js/README.md.)\n' "$note" >> "$2"
}
mk "$T/crtcheck/tscheck/CrtCheck.ts" "$HERE/rt/CrtCheck.js" ../src/cpp/ ../../src/cpp/
mk "$T/stdcheck/sortcheck.mts" "$HERE/rt/sortcheck.js" ../../ts/src/cpp/ ../../src/cpp/
mk "$T/stdcheck/hashcheck.mts" "$HERE/rt/hashcheck.js" ../../ts/src/cpp/ ../../src/cpp/
mk "$T/stdcheck/containercheck.mts" "$HERE/rt/containercheck.js" ../../ts/src/cpp/ ../../src/cpp/
mk "$T/stdcheck/streamcheck_ts/streamcheck.ts" "$HERE/rt/streamcheck.js" ../../../ts/src/cpp/ ../../src/cpp/
for f in check check2 powdiff; do mk "$ROOT/tools/libm/test/$f.ts" "$HERE/libm/$f.js"; done
echo "wrote js/test/rt/{CrtCheck,sortcheck,hashcheck,containercheck,streamcheck}.js and js/test/libm/{check,check2,powdiff}.js"
