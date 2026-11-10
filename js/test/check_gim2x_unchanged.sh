#!/bin/bash
# check_gim2x_unchanged.sh OLD_GIM2X NEW_GIM2X GLIBM_BUILD OUT
# The JavaScript back end was added to tools/libm/gim2x.py; this shows that the other back ends write what they wrote
# before. Every set-1 and set-2 file of the TypeScript, Java and Go runtimes (tools/libm/make_libm.sh's command lines)
# and of the Kotlin and Groovy runtimes (kotlin/make_glibm.sh, groovy/make_glibm.sh) is written into OUT/old with the
# gim2x.py of the last commit and into OUT/new with the new one, from the same GIMPLE dumps and tables (GLIBM_BUILD,
# made by tools/libm/build_glibm.sh and extract_tables.py), and compared byte for byte; then each new file is compared
# with the one committed in the repository, outside // comments (the committed set-1 files carry other --header lines
# and the TypeScript one another import path, as groovy/results/gim2x_unchanged.txt notes). The JavaScript files the new
# back end writes are compared with js/src/cpp/libm. Nothing is written into the repository.
# Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see js/README.md.
set -u
OLD=$1; NEW=$2; W=$3; OUT=$4
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
G=$W/gimple
D1="$G/e_exp.c.254t.optimized $G/e_log.c.254t.optimized $G/e_pow.c.254t.optimized $G/s_sin.c.254t.optimized
    $G/s_tan.c.254t.optimized $G/e_asin.c.254t.optimized $G/s_atan.c.254t.optimized $G/e_log10.c.254t.optimized"
D2="$G/s_expm1.c.254t.optimized $G/e_sinh.c.254t.optimized $G/e_cosh.c.254t.optimized $G/s_tanh.c.254t.optimized
    $G/s_log1p.c.254t.optimized $G/e_log2.c.254t.optimized $G/e_atan2.c.254t.optimized $G/s_cbrt.c.254t.optimized
    $G/e_hypot.c.254t.optimized"
N1="--name my_exp_fma=exp --name my_log=log --name my_sin=sin --name my_cos=cos --name my_tan=tan
    --name my_asin=ieee754_asin --name my_acos=ieee754_acos --name my_atan=atan --name my_log10=ieee754_log10"
N2="--name my_expm1=expm1_t --name my_sinh=sinh_t --name my_cosh=cosh_t --name my_tanh=tanh_t --name my_log1p=log1p_t
    --name my_log2=log2_t --name my_atan2=atan2_t --name my_cbrt=cbrt_t --name my_hypot=hypot_t"
T1="--tables $W/tables.json"; T2="--tables $W/tables.json --table-prefix T2_"
LG="Derived from the GNU C Library (glibc) 2.39 and so, like glibc's libm, licensed under the GNU Lesser General Public License, version 2.1 or later (LGPL-2.1-or-later)."
gen() {   # gen GIM2X DIR [js]
	local X="python3 $1" O=$2
	mkdir -p "$O"
	# tools/libm/make_libm.sh (set 2 with its headers; set 1 as --all writes it)
	H2=(--header "Set 2: atan2, log2, sinh, tanh, expm1 and log1p from glibc's FMA variants (sysdeps/x86_64/fpu/multiarch, -mfma -mavx2);"
	    --header "cosh, cbrt and hypot generic. sinh and cosh call set 1's exp (glibm). The public functions at the end pin down NaN results."
	    --header "$LG" --header "Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.")
	$X ts "$O/glibm2.ts" $D2 $T2 $N2 --name my_exp_fma=G.exp --rt ./glibm2_rt.js --import 'import * as G from "./glibm.js";' "${H2[@]}" > /dev/null
	$X java "$O/Glibm2.java" $D2 $T2 $N2 --name my_exp_fma=Glibm.exp --package cpp --rt Glibm2Rt "${H2[@]}" > /dev/null
	$X go "$O/glibm2.go" $D2 $T2 --name my_exp_fma=Exp --name my_expm1=Expm1 --name my_sinh=Sinh --name my_cosh=Cosh \
		--name my_tanh=Tanh --name my_log1p=Log1p --name my_log2=Log2 --name my_atan2=atan2_t --name my_cbrt=Cbrt \
		--name my_hypot=hypot_t "${H2[@]}" > /dev/null
	$X ts "$O/glibm.ts" $D1 $T1 $N1 --name my_pow=pow_exact --rt ./glibm_rt.js > /dev/null
	$X java "$O/Glibm.java" $D1 $T1 $N1 --name my_pow=pow --package cpp > /dev/null
	$X go "$O/glibm.go" $D1 $T1 --name my_exp_fma=Exp --name my_log=Log --name my_pow=Pow --name my_sin=Sin --name my_cos=Cos \
		--name my_tan=Tan --name my_asin=ieee754_asin --name my_acos=ieee754_acos --name my_atan=Atan \
		--name my_log10=ieee754_log10 > /dev/null
	gofmt -w "$O/glibm.go" "$O/glibm2.go"
	# kotlin/make_glibm.sh and groovy/make_glibm.sh
	for L in kt groovy; do
		local P=Kotlin; [ $L = groovy ] && P=Groovy
		local E=kt; [ $L = groovy ] && E=groovy
		local WB="Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see ${P,,}/README.md."
		[ $L = kt ] && WB="Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see kotlin/README.md."
		$X $L "$O/Glibm.$E" $D1 $T1 --package cpp --rt GlibmRt $N1 --name my_pow=pow \
			--header "Set 1: exp, log, pow, sin, cos, tan, asin, acos, atan from glibc's FMA variants; log10 generic." \
			--header "$LG" --header "$WB" > /dev/null
		$X $L "$O/Glibm2.$E" $D2 $T2 --package cpp --rt Glibm2Rt $N2 --name my_exp_fma=Glibm.exp \
			--header "Set 2: atan2, log2, sinh, tanh, expm1 and log1p from glibc's FMA variants (sysdeps/x86_64/fpu/multiarch, -mfma -mavx2);" \
			--header "cosh, cbrt and hypot generic. sinh and cosh call set 1's exp (Glibm). The public functions at the end pin down NaN results." \
			--header "$LG" --header "$WB" > /dev/null
	done
	if [ "${3:-}" = js ]; then JS_OUT=$O "$ROOT/js/make_glibm.sh" "$W" > /dev/null; fi
}
rm -rf "$OUT/old" "$OUT/new"
gen "$OLD" "$OUT/old"
gen "$NEW" "$OUT/new" js
echo "# old gim2x.py: $OLD (md5 $(md5sum < "$OLD" | cut -c1-32)); new: $NEW (md5 $(md5sum < "$NEW" | cut -c1-32))"
echo "# GIMPLE dumps and tables: $W ($(ls "$W"/gimple/*.optimized | wc -l) dumps, tables.json md5 $(md5sum < "$W/tables.json" | cut -c1-32))"
fail=0
for f in glibm.go glibm2.go Glibm.java Glibm2.java glibm.ts glibm2.ts Glibm.kt Glibm2.kt Glibm.groovy Glibm2.groovy; do
	if cmp -s "$OUT/old/$f" "$OUT/new/$f"; then echo "$f: old and new identical ($(wc -l < "$OUT/new/$f") lines, md5 $(md5sum < "$OUT/new/$f" | cut -c1-32))"
	else echo "$f: old and new DIFFER"; diff "$OUT/old/$f" "$OUT/new/$f" | head -5; fail=1; fi
done
echo "# the new files against the committed ones, outside // comments"
nc() { grep -v '^\s*//' "$1"; }
for p in go/glibm/glibm.go:glibm.go go/glibm/glibm2.go:glibm2.go java/src/cpp/Glibm.java:Glibm.java java/src/cpp/Glibm2.java:Glibm2.java \
	ts/src/cpp/libm/glibm.ts:glibm.ts ts/src/cpp/libm/glibm2.ts:glibm2.ts kotlin/src/cpp/Glibm.kt:Glibm.kt kotlin/src/cpp/Glibm2.kt:Glibm2.kt \
	groovy/src/cpp/Glibm.groovy:Glibm.groovy groovy/src/cpp/Glibm2.groovy:Glibm2.groovy; do
	c=${p%%:*}; n=${p#*:}
	k=$(diff <(nc "$ROOT/$c") <(nc "$OUT/new/$n") | grep -c '^[<>]')
	echo "$c vs new $n: $k differing lines outside // comments"
	[ "$k" -gt 0 ] && diff <(nc "$ROOT/$c") <(nc "$OUT/new/$n") | head -6 | sed 's/^/    /'
done
echo "# the JavaScript files the new back end writes, against js/src/cpp/libm"
for f in glibm.js glibm2.js glibm_rt.js glibm2_rt.js; do
	if cmp -s "$OUT/new/$f" "$ROOT/js/src/cpp/libm/$f"; then echo "js/src/cpp/libm/$f: identical to the regenerated file"; else echo "js/src/cpp/libm/$f: DIFFERS from the regenerated file"; fail=1; fi
done
exit $fail
