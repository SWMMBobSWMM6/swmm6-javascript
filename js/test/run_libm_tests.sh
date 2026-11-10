#!/bin/bash
# run_libm_tests.sh [N] [N2]
# Check the JavaScript translations of glibc's math routines (js/src/cpp/libm: glibm.js and glibm2.js, written by
# tools/libm/gim2x.py's JavaScript back end, and their runtimes glibm_rt.js and glibm2_rt.js) bit for bit against the
# system libm (glibc 2.39, the library the C++ SWMM6 engine calls), by the method of tools/libm/test/run_tests.sh and
# with its programs (check.js, check2.js and powdiff.js here are tools/libm/test's check.ts, check2.ts and powdiff.ts
# without their types: js/tools/ts2js.mjs):
#   set 1: N random arguments per function over the ranges SWMM uses plus special values (tools/libm/test/mkvectors.c)
#     and 100,000 edge cases per function (mkedge.c): exp, log, log10, pow, sin, cos, tan, asin, acos, atan and fma;
#     and 20 million arguments of pow's hand-written fast path against pow_exact, the full translation (powdiff.js);
#   set 2: N2 random arguments per function over wide ranges and every branch threshold, +-0, +-inf, subnormals and
#     NaNs of both signs with several payloads, every pair of special values for atan2 and hypot (mkvectors2.c):
#     cbrt, hypot, atan2, cosh, sinh, tanh, log2, expm1, log1p, frexp, ldexp; a NaN must match in sign and payload.
# Each runs under V8's optimizing compiler (Node's default) and again with --jitless (the interpreter only), since V8's
# optimized code once cleared a NaN's sign that the interpreter kept (SWMM5 lessons/30).
# The vectors (about 0.5 GB at the defaults) go to W (default /dev/shm/js6_libm_test), deleted at the end.
# Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see ../README.md.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); J=$(cd "$HERE/.." && pwd); ROOT=$(cd "$J/.." && pwd)
N=${1:-1000000}; N2=${2:-1000000}; W=${W:-/dev/shm/js6_libm_test}; rm -rf "$W"; mkdir -p "$W/js"
T=$ROOT/tools/libm/test
gcc -O2 -o "$W/mkvectors" "$T/mkvectors.c" -lm
gcc -O2 -o "$W/mkedge" "$T/mkedge.c" -lm
gcc -O2 -fno-builtin -o "$W/mkvectors2" "$T/mkvectors2.c" -lm
"$W/mkvectors" "$N" "$W/vectors.bin" > /dev/null 2>&1
"$W/mkedge" 100000 "$W/edge.bin" > /dev/null 2>&1
"$W/mkvectors2" "$N2" "$W/vectors2.bin" > /dev/null 2>&1
# the checks import ./glibm.js and the rest from their own folder, as in tools/libm/test/run_tests.sh
cp "$J"/src/cpp/libm/glibm.js "$J"/src/cpp/libm/glibm_rt.js "$J"/src/cpp/libm/glibm2.js "$J"/src/cpp/libm/glibm2_rt.js \
   "$HERE"/libm/check.js "$HERE"/libm/check2.js "$HERE"/libm/powdiff.js "$W/js/"
echo '{"type":"module"}' > "$W/js/package.json"
echo "Node $(node --version); system libm: $(ldd --version | head -1)"
cd "$W/js"
for mode in "" "--jitless"; do
	echo "== JavaScript ${mode:-(optimizing compiler)}, set 1: vectors.bin (N = $N per function)"; node $mode check.js "$W/vectors.bin"
	echo "== JavaScript ${mode:-(optimizing compiler)}, set 1: edge.bin (100,000 per function)"; node $mode check.js "$W/edge.bin"
	echo "== JavaScript ${mode:-(optimizing compiler)}, set 2: vectors2.bin (N2 = $N2 per function)"; node $mode check2.js "$W/vectors2.bin"
done
echo "== JavaScript, pow's fast path against pow_exact (20 million arguments)"; node powdiff.js 20
cd /; rm -rf "$W"
