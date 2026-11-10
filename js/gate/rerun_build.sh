#!/bin/bash
# rerun_build.sh [COMMIT] [DIR] [GLIBC_SRC] - the first half of the independent rerun: a clean copy of COMMIT (default
# HEAD) of this repository (git archive) in DIR (default /dev/shm/js6_v), where
#   - the translator is rebuilt (tools/cs2x/build_js.sh) and the engine regenerated from cs/gen, then compared byte for
#     byte with the committed js/gen/engine.js;
#   - the runtime is written again from ts/src (js/make_runtime.sh) and compared with the committed js/src;
#   - the math is translated again: glibc's sources (GLIBC_SRC, default /home/claude/ext/glibc, release/2.39/master at
#     ce65d944e38a) compiled to GIMPLE (tools/libm/build_glibm.sh: only compiled, nothing of glibc is run), the tables
#     read from the objects (extract_tables.py), then js/make_glibm.sh, and compared with the committed
#     js/src/cpp/libm/glibm.js, glibm2.js, glibm_rt.js and glibm2_rt.js;
#   - the check programs are written again (js/test/make_checks.sh) and compared with the committed ones.
# The gate then runs that copy:
#   js/gate/run_chunk.sh js6_v_a corpus js/gate/ids_corpus_a.txt DIR/js/runswmm6_saves.sh   (and _b, _c)
# Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see ../README.md.
set -e
J=$(cd "$(dirname "$0")/.." && pwd); ROOT=$(cd "$J/.." && pwd)
C=${1:-HEAD}; R=${2:-/dev/shm/js6_v}; GL=${3:-/home/claude/ext/glibc}
rm -rf "$R"; mkdir -p "$R/repo"
git -C "$ROOT" archive "$C" | tar -x -C "$R/repo"
echo "== clean copy of $(git -C "$ROOT" rev-parse --short "$C") in $R/repo"
cd "$R/repo"
same() {   # same NAME A B: the two trees (or files) byte for byte
	if diff -r -q "$2" "$3" > /dev/null; then echo "$1: byte-identical to the commit ($(find "$3" -type f | wc -l) files, $(find "$3" -type f -exec cat {} + | wc -l) lines)"
	else echo "$1: DIFFERENT"; diff -r -q "$2" "$3" | head; exit 1; fi
}
echo "== the translator (tools/cs2x/build_js.sh) and the engine, regenerated from cs/gen"
nice -n 10 tools/cs2x/build_js.sh
nice -n 10 dotnet tools/cs2x/bin/cs2js.dll cs "$R/regen/gen"
same "engine js/gen/engine.js" "$R/regen/gen" js/gen
for f in cs2js_runtime.txt cs2js_notes.txt cs2js_todo.txt; do cmp "$R/regen/$f" js/$f; done
echo "manifest, notes and TODO list (js/cs2js_*.txt): byte-identical to the commit"
echo "== the runtime, written again from ts/src (js/make_runtime.sh)"
JS_OUT="$R/regen/src" js/make_runtime.sh
cp -a js/src/cpp/libm/glibm.js js/src/cpp/libm/glibm2.js js/src/cpp/libm/glibm_rt.js js/src/cpp/libm/glibm2_rt.js "$R/regen/src/cpp/libm/"
same "runtime js/src (the four math files aside, compared below)" "$R/regen/src" js/src
echo "== the math: glibc 2.39 compiled to GIMPLE in $R/glibm, then js/make_glibm.sh"
nice -n 10 tools/libm/build_glibm.sh "$GL" "$R/glibm" > "$R/glibm_build.log" 2>&1
nice -n 10 python3 tools/libm/extract_tables.py "$R/glibm" "$R/glibm/tables.json" > /dev/null
JS_OUT="$R/regen/libm" js/make_glibm.sh "$R/glibm"
for f in glibm.js glibm2.js glibm_rt.js glibm2_rt.js; do cmp "$R/regen/libm/$f" js/src/cpp/libm/$f; done
echo "math js/src/cpp/libm (glibm.js, glibm2.js, glibm_rt.js, glibm2_rt.js): byte-identical to the commit"
echo "== the check programs, written again (js/test/make_checks.sh)"
cp -a js/test "$R/test_committed"
js/test/make_checks.sh > /dev/null
same "checks js/test" "$R/test_committed" js/test
rm -rf "$R/regen" "$R/test_committed" "$R/glibm"
echo "== syntax of every file Node will load"
n=0; for f in $(find js/gen js/src -name '*.js'); do node --check "$f"; n=$((n + 1)); done; echo "node --check: $n files, no errors"
echo "rerun copy ready: $R/repo/js/runswmm6_saves.sh"
