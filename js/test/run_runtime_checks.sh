#!/bin/bash
# run_runtime_checks.sh [N] - check the JavaScript runtime (js/src/cpp) with the checks that prove the TypeScript runtime
# it is derived from (tests/ of this repository), each program the TypeScript one without its types (make_checks.sh):
#   crtcheck  rt/CrtCheck.js (tests/crtcheck/tscheck/CrtCheck.ts) against the system's glibc (tests/crtcheck: libm.c,
#             printf.c, scanf.c, misc.cpp): libm bit for bit (N cases per function), printf output, sscanf results,
#             from_chars / strtol / strtod / atoi / ctime / ctype, and unit checks of the rest
#   sort/hash rt/sortcheck.js, hashcheck.js, containercheck.js (tests/stdcheck/*.mts) against libstdc++ (sortcheck.cpp,
#             hashcheck.cpp, containercheck.cpp): introsort's permutations, unordered_map / unordered_set node order,
#             std::hash, 64-bit keys, rehashing, map / set, stack / queue, partial sorts; and the prime table
#   streams   rt/streamcheck.js (tests/stdcheck/streamcheck_ts/streamcheck.ts) against libstdc++ and the C# runtime
#             (streamcheck.cpp and streamcheck.cs, built here), as tests/stdcheck/run_stream_ts.sh compares the TypeScript
# Everything is built in W (default /dev/shm/js6_rtcheck) and deleted at the end; tests/ is only read.
# Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see ../README.md.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); J=$(cd "$HERE/.." && pwd); ROOT=$(cd "$J/.." && pwd); T=$ROOT/tests
N=${1:-300000}; W=${W:-/dev/shm/js6_rtcheck}; rm -rf "$W"; mkdir -p "$W"
fail=0
echo "Node $(node --version); $(ldd --version | head -1); $(g++ --version | head -1)"
echo "== crtcheck: the C library against glibc"
for p in libm printf scanf; do gcc -O2 -ffp-contract=off -fno-builtin -o "$W/$p" "$T/crtcheck/$p.c" -lm; done
g++ -O2 -std=c++20 -o "$W/misc" "$T/crtcheck/misc.cpp"
C="node $HERE/rt/CrtCheck.js"
"$W/libm" $N | $C libm $N; "$W/printf" | $C printf; "$W/scanf" | $C scanf; "$W/misc" | $C misc; $C units
echo "== sort, hash and containers against libstdc++"
for p in sortcheck hashcheck containercheck primes; do g++ -O2 -std=c++20 -o "$W/$p" "$T/stdcheck/$p.cpp"; done
"$W/sortcheck" > "$W/sort_cpp.txt"; "$W/hashcheck" > "$W/hash_cpp.txt"; "$W/containercheck" > "$W/cont_cpp.txt"
check() {   # check <name> <C++ output> <JavaScript output>
	if cmp -s "$2" "$3"; then echo "$1: identical"; else echo "$1: DIFFERENT"; diff "$2" "$3" | head -5 | cut -c1-300; fail=1; fi
}
echo "sort cases: $(wc -l < "$W/sort_cpp.txt")"
for mode in O N; do
	node "$HERE/rt/sortcheck.js" $mode > "$W/sort_js_$mode.txt"
	check "sort, stable_sort, partial_sort ($mode)" "$W/sort_cpp.txt" "$W/sort_js_$mode.txt"
done
node "$HERE/rt/hashcheck.js" > "$W/hash_js.txt"
echo "hash lines: $(wc -l < "$W/hash_cpp.txt")"
check "unordered_map / unordered_set order and std::hash" "$W/hash_cpp.txt" "$W/hash_js.txt"
node "$HERE/rt/containercheck.js" > "$W/cont_js.txt"
echo "container lines: $(wc -l < "$W/cont_cpp.txt")"
check "64-bit keys, rehash, map / set, stack / queue, partial sorts, algorithms" "$W/cont_cpp.txt" "$W/cont_js.txt"
"$W/primes" | grep -o '[0-9]*UL' | tr -d UL > "$W/primes_cpp.txt"
node --input-type=module -e "import { PrimeList } from '$J/src/cpp/primelist.js'; console.log(PrimeList.P.join('\\n'));" > "$W/primes_js.txt"
check "prime list ($(wc -l < "$W/primes_cpp.txt") entries)" "$W/primes_cpp.txt" "$W/primes_js.txt"
echo "== streams and file system against libstdc++ and the C# runtime (as tests/stdcheck/run_stream_ts.sh compares the TypeScript)"
FW=$(ls -d /usr/lib/dotnet/shared/Microsoft.NETCore.App/8.* | head -1)
CSC=$(ls /usr/lib/dotnet/sdk/*/Roslyn/bincore/csc.dll | head -1)
REFS=$(for f in $FW/*.dll; do case $(basename $f) in Microsoft.VisualBasic*|mscorlib.dll|netstandard.dll|System.Private.*) ;; *) echo -n "-r:$f ";; esac; done)
RT=$(ls "$ROOT"/cs/runtime/*.cs | grep -v -e Program.cs -e /Hand_)
mkdir -p "$W/cs" "$W/s/build"     # the programs write and read build/streamcheck.bin in their working folder
g++ -O2 -std=c++20 -o "$W/streamcheck" "$T/stdcheck/streamcheck.cpp"
dotnet "$CSC" -nologo -optimize+ -nowarn:CS8632,CS0162,CS0168 -langversion:latest -out:"$W/cs/streamcheck.dll" $REFS -r:$FW/netstandard.dll \
  -r:$FW/System.Private.CoreLib.dll "$T/stdcheck/streamcheck.cs" $RT > /dev/null
printf '{"runtimeOptions":{"tfm":"net8.0","framework":{"name":"Microsoft.NETCore.App","version":"%s"}}}' $(basename $FW) > "$W/cs/streamcheck.runtimeconfig.json"
for s in a c; do (cd "$W/s" && "$W/streamcheck" $s > "$W/stream_cpp_$s.txt"); done
for s in a b c; do
	(cd "$W/s" && node "$HERE/rt/streamcheck.js" $s > "$W/stream_js_$s.txt")
	# the C# side, built here from cs/runtime; if that program fails (groovy/test/run_runtime_checks.sh found its section a
	# failing in November 2026), the outputs recorded in tests/stdcheck/build are used, as there
	if ! (cd "$W/s" && dotnet "$W/cs/streamcheck.dll" $s > "$W/stream_cs_$s.txt" 2> "$W/stream_cs_$s.err"); then
		echo "  (C# streamcheck $s failed: $(grep -m1 -o 'System[.A-Za-z]*Exception[^\r]*' "$W/stream_cs_$s.err"); using tests/stdcheck/build/stream_cs_$s.txt)"
		cp "$T/stdcheck/build/stream_cs_$s.txt" "$W/stream_cs_$s.txt"
	fi
done
quirk() { local d; d=$(diff "$1" "$2" | grep '^[<>]' || true); [ "$d" = $'< d 01 2 [1.0e+02]\n> d 01 2 [1.e+02]' ] || [ "$d" = $'< d 01 2 [1.e+02]\n> d 01 2 [1.0e+02]' ]; }
echo "section a: $(wc -l < "$W/stream_js_a.txt") lines"
for o in cs:C# cpp:C++; do
	f=$W/stream_${o%%:*}_a.txt; n=${o#*:}
	if cmp -s $f "$W/stream_js_a.txt"; then echo "  $n and JavaScript: identical"
	elif quirk $f "$W/stream_js_a.txt"; then echo "  $n and JavaScript: identical but for the glibc %#g quirk line (printf \"%#.2g\" of 99.995)"
	else echo "  $n and JavaScript: DIFFERENT"; diff $f "$W/stream_js_a.txt" | head -8; fail=1; fi
done
cmp -s "$W/stream_cs_a.txt" "$W/stream_js_a.txt" || cmp -s "$W/stream_cpp_a.txt" "$W/stream_js_a.txt" || { echo "  JavaScript equals neither C# nor C++ exactly"; fail=1; }
echo "section b: $(wc -l < "$W/stream_js_b.txt") lines"
if cmp -s "$W/stream_cs_b.txt" "$W/stream_js_b.txt"; then echo "  C# and JavaScript: identical"; else echo "  C# and JavaScript: DIFFERENT"; diff "$W/stream_cs_b.txt" "$W/stream_js_b.txt" | head -8; fail=1; fi
echo "section c: $(cat "$W/stream_js_c.txt")"
for o in cpp:C++ cs:C#; do
	if cmp -s "$W/stream_${o%%:*}_c.txt" "$W/stream_js_c.txt"; then echo "  ${o#*:} and JavaScript: identical"; else echo "  ${o#*:} and JavaScript: DIFFERENT"; fail=1; fi
done
[ "${KEEP:-0}" = 1 ] || rm -rf "$W"
echo "exit=$fail"
exit $fail
