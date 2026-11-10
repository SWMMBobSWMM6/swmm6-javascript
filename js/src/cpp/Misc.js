// Misc.js - runtime part C (cs/runtime/Misc.cs except Algo, Mv, Conv, Dtor, Defer and Box, which a_std.ts, a_long.ts
// and algo.ts have; plus Variant from cs/runtime/Std.cs and SysException): the rest of the small runtime the
// TypeScript SWMM6 engine calls:
// libm functions .NET does not route to glibc (LibM), <utility> / <charconv> helpers (Std, FromCharsResult),
// std::error_code, atomics, locks and threads for one thread, tuples, raw memory on typed arrays (Mem, Bytes, Bits,
// Num), std::chrono (TimePoint, Duration), hardware_concurrency, object identities, the debugging trace, once flags,
// std::variant and the .NET exceptions the engine throws itself.
// Type-dependent members (ts/RUNTIME_HELPERS.md) have one member per type code: i int, u uint, l long, ul ulong,
// s short, us ushort, c sbyte, uc byte, ch char, b bool, f float, d double. A typed array is seen as its
// little-endian bytes (x86's layout), as C#'s MemoryMarshal.AsBytes sees it: copying part of an element changes only
// those bytes of it; a bool is one byte (0 or 1 when written, any nonzero byte read as true).
// The Java port of this part (java/src/cpp/Mem.java, Bytes.java, Std.java, LibM.java, ...) is the model.
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as cpp from './index.js';
import {  R } from './CRuntime.js';
import * as G from './libm/glibm.js';
import * as G2 from './libm/glibm2.js';
import { DEFAULT_NAN, quietNaN, pickNaN } from './libm/nan.js';





const SAFE = 9007199254740991;
const F64 = new Float64Array(1);
const W32 = new Uint32Array(F64.buffer);
function signBit(x) { F64[0] = x; return (W32[1] >>> 31) === 1; }

function canonL(b) {
	const r = BigInt.asIntN(64, b);
	return r >= -9007199254740991n && r <= 9007199254740991n ? Number(r) : r;
}
function canonUL(b) {
	const r = BigInt.asUintN(64, b);
	return r <= 9007199254740991n ? Number(r) : r;
}
function addL(a, b) {
	if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r >= -SAFE && r <= SAFE) return r === 0 ? 0 : r; }
	return canonL(BigInt(a) + BigInt(b));
}
function subL(a, b) {
	if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r >= -SAFE && r <= SAFE) return r === 0 ? 0 : r; }
	return canonL(BigInt(a) - BigInt(b));
}
function addUL(a, b) {
	if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= SAFE) return r; }
	return canonUL(BigInt(a) + BigInt(b));
}
function subUL(a, b) {
	if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r >= 0) return r === 0 ? 0 : r; }
	return canonUL(BigInt(a) - BigInt(b));
}
/** The low 32 bits of a long or ulong as an int. */
function toI32(x) { return typeof x === 'number' ? x | 0 : Number(BigInt.asIntN(32, x)); }
/** A long or ulong as a JavaScript index or count (it is a safe integer wherever the engine uses it as one). */
function ix(x) { return typeof x === 'number' ? x : Number(x); }
/** x86-64 cvttsd2si to a long: NaN and out-of-range values give -2^63. */
function d2l(x) {
	if (!(x >= -9223372036854775808 && x < 9223372036854775808)) return -9223372036854775808n;
	const t = Math.trunc(x);
	return t >= -SAFE && t <= SAFE ? t + 0 : BigInt(t);
}
/** C#'s EqualityComparer<T>.Default.Equals: numbers by value with NaN equal to NaN (double.Equals), longs across
 *  number and bigint, objects by their Equals or identity. */
function eqDefault(a, b) {
	if (a === b) return true;
	const ta = typeof a, tb = typeof b;
	if (ta === 'number' && tb === 'number') return a !== a && b !== b;
	if ((ta === 'number' || ta === 'bigint') && (tb === 'number' || tb === 'bigint')) return a == b;
	if (a !== null && a !== undefined && ta === 'object' && typeof a.Equals === 'function') return !!a.Equals(b);
	return false;
}
/** Elem<T>.Copy: a class (ICopy) is copied with Clone, an array element by element, a value as it is. */
function elemCopy(x) {
	if (x === null || x === undefined || typeof x !== 'object') return x;
	if (Array.isArray(x)) return x.map(elemCopy);
	return typeof x.Clone === 'function' ? x.Clone() : x;
}
/** A minimal reference to a local value (the shape of part A's cpp.Ref). */
class LocalRef {
	v;
	constructor(v) { this.v = v; }
	get() { return this.v; }
	set(x) { this.v = x; }
}

// ------------------------------------------------------------------------------------------------ Raw, delegates

/** The argument of the constructors that leave an object for an __init method (C# Cpp.Raw, a struct). */
export class Raw {
	static V = new Raw();
	static ZERO = Raw.V;
	Clone() { return this; }
}
/** A C++ pointer to data member T C::* (C# delegate ref TF MemPtr<TO, TF>(TO o)): given the object, a reference to
 *  that field of it. */

/** A reference member of a class (C# delegate ref T RefGet<T>()): the place it refers to. */

/** A container whose elements a destructor runs (C# Cpp.IDestroyElems). */


/** A .NET exception the C# engine throws itself (NotImplementedException, OverflowException, ...), by its type name
 *  and message. It is not a cpp.CppException: only the engine's catch-all clauses take it. */
export class SysException extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.kind = kind;
		this.name = 'System.' + kind;
	}
	toString() { return 'System.' + this.kind + ': ' + this.message; }
}

// ------------------------------------------------------------------------------------------------ LibM

/** The libm functions the C# runtime calls from glibc directly (C# Cpp.LibM). fmod, remainder, round, rint,
 *  nearbyint, lround, nextafter, fdim, fmax and fmin are exact here, with glibc's NaNs; log is glibm's (bit-exact
 *  glibc 2.39); hypot, expm1 and log1p are libm/glibm2.ts's (the same translation of glibc 2.39: hypot generic,
 *  expm1 and log1p from the FMA variants; bit-exact, NaNs included; the FV solver's norms call hypot, lessons/30);
 *  exp2 is glibm's pow(2, x). erf, erfc, tgamma and lgamma, which the C# runtime also declares, throw NotImplementedException: the engine does not call
 *  them and JavaScript has no glibc-exact counterpart. */
export class LibM {
	/** C nextafter: the next double after x toward y (y itself when equal, NaN if either is NaN). */
	static nextafter(x, y) {
		if (x !== x || y !== y) return pickNaN(y, x);
		if (x === y) return y;
		if (x === 0) return signBit(y) ? -5e-324 : 5e-324;     // either zero: the smallest subnormal toward y
		F64[0] = x;
		let hi = W32[1], lo = W32[0];
		if ((y > x) === (x > 0)) { lo = (lo + 1) >>> 0; if (lo === 0) hi = (hi + 1) >>> 0; }
		else { if (lo === 0) hi = (hi - 1) >>> 0; lo = (lo - 1) >>> 0; }
		W32[1] = hi; W32[0] = lo;
		return F64[0];
	}
	/** C hypot (glibm2's: infinite if either argument is, with a quiet NaN; a signalling NaN gives the NaN). */
	static hypot(x, y) { return G2.hypot(x, y); }
	/** C fmod (exact; JavaScript's % on doubles is C's fmod): NaN when y is zero or x infinite. */
	static fmod(x, y) {
		if (x !== x || y !== y) return pickNaN(x, y);
		if (y === 0 || x === Infinity || x === -Infinity) return DEFAULT_NAN;
		return x % y;
	}
	/** C round: halfway cases away from zero (exact). */
	static round(x) {
		if (x !== x || x === Infinity || x === -Infinity) return x + x;
		const a = Math.abs(x);
		if (a >= 4503599627370496) return x;                       // 2^52: already an integer
		let t = Math.floor(a);
		if (a - t >= 0.5) t += 1;                                  // a - t is exact below 2^52
		return signBit(x) ? -t : t;
	}
	/** C lround: round, then the integer (LONG_MIN when out of range, as x86-64's conversion gives). */
	static lround(x) { return d2l(LibM.round(x)); }
	static expm1(x) { return G2.expm1(x); }
	static log1p(x) { return G2.log1p(x); }
	/** rint and nearbyint in the default rounding mode: half to even (exact). */
	static rint(x) {
		if (x !== x) return quietNaN(x);
		const a = Math.abs(x);
		if (a >= 4503599627370496) return x;
		const t = (a + 4503599627370496) - 4503599627370496;      // the FPU rounds the sum half to even
		return signBit(x) ? -t : t;
	}
	static nearbyint(x) { return LibM.rint(x); }
	static erf(x) { throw new SysException('NotImplementedException', 'erf is not in the TypeScript runtime'); }
	static erfc(x) { throw new SysException('NotImplementedException', 'erfc is not in the TypeScript runtime'); }
	static tgamma(x) { throw new SysException('NotImplementedException', 'tgamma is not in the TypeScript runtime'); }
	static lgamma(x) { throw new SysException('NotImplementedException', 'lgamma is not in the TypeScript runtime'); }
	static exp2(x) { return G.pow(2, x); }
	/** C remainder (exact; the quotient rounded half to even), as fdlibm's e_remainder.c computes it. */
	static remainder(x, y) {
		if (x !== x || y !== y) return pickNaN(y, x);
		if (y === 0 || x === Infinity || x === -Infinity) return DEFAULT_NAN;
		const p = Math.abs(y);
		const sx = signBit(x);
		let a = Math.abs(x);
		if (p <= 8.98846567431158e307) a = a % (p + p);            // fmod(x, 2p), exact
		if (p < 4.450147717014403e-308) {                           // 2^-1021
			if (a + a > p) { a -= p; if (a + a >= p) a -= p; }
		} else {
			const ph = 0.5 * p;
			if (a > ph) { a -= p; if (a >= ph) a -= p; }
		}
		return sx ? -a : a;
	}
	static fdim(x, y) {
		if (x !== x || y !== y) return pickNaN(x, y);
		return x > y ? x - y : 0;
	}
	/** C fmax / fmin: a NaN argument is ignored unless both are NaN. */
	static fmax(x, y) {
		if (x !== x) return y !== y ? pickNaN(x, y) : y;
		if (y !== y) return x;
		if (x === 0 && y === 0) return signBit(x) ? y : x;
		return x > y ? x : y;
	}
	static fmin(x, y) {
		if (x !== x) return y !== y ? pickNaN(x, y) : y;
		if (y !== y) return x;
		if (x === 0 && y === 0) return signBit(x) ? x : y;
		return x < y ? x : y;
	}
	static log(x) { return G.log(x); }
}

// ------------------------------------------------------------------------------------------------ Std

/** <utility>, <exception>, <mutex>, <span> and <charconv> helpers of the engine (C# Cpp.Std). */
export class Std {
	/** C++'s quiet NaN (the bits 0x7FF8000000000000), its signalling NaN and the float quiet NaN. */
	static QNaN = (() => { W32[1] = 0x7ff80000; W32[0] = 0; return F64[0]; })();
	static SNaN = (() => { W32[1] = 0x7ff40000; W32[0] = 0; return F64[0]; })();
	static QNaNf = (() => { const f = new Float32Array(1); new Uint32Array(f.buffer)[0] = 0x7fc00000; return f[0]; })();

	/** std::rethrow_exception: throw the stored exception again. */
	static Rethrow(e) { throw e; }
	/** std::call_once: run f the first time only (single-threaded; an exception leaves the flag unset). */
	static call_once(flag, f) {
		if (flag.done) return;
		f();
		flag.done = true;
	}
	// std::span of a vector, an array, a pointer and a count, or another span (part A's CSpan)
	static Span_() { return cpp.CSpan.ZERO; }
	static Span_VecT(v) { return new cpp.CSpan(v.a, 0, v.n); }
	static Span_TA(arr) { return new cpp.CSpan(arr, 0, arr.length); }
	static Span_PtrT_ul(p, n) { const q = p; return new cpp.CSpan(q.a, q.o, canonL(BigInt(n))); }
	static Span_CSpanT(s) { return s; }
	// std::get<i> of a pair or tuple (structured bindings of map entries and emplace results): the value, and with
	// ref_ a reference to the element
	static get0_PairAB(p) { return p.first; }
	static get1_PairAB(p) { return p.second; }
	static ref_get0_PairAB(p) { return cpp.fieldRef(p, 'first'); }
	static ref_get1_PairAB(p) { return cpp.fieldRef(p, 'second'); }
	static get0_TupAB(t) { return t.i0; }
	static get1_TupAB(t) { return t.i1; }
	static ref_get0_TupAB(t) { return cpp.fieldRef(t, 'i0'); }
	static ref_get1_TupAB(t) { return cpp.fieldRef(t, 'i1'); }
	static get0_TupABC(t) { return t.i0; }
	static get1_TupABC(t) { return t.i1; }
	static get2(t) { return t.i2; }
	static ref_get0_TupABC(t) { return cpp.fieldRef(t, 'i0'); }
	static ref_get1_TupABC(t) { return cpp.fieldRef(t, 'i1'); }
	static ref_get2(t) { return cpp.fieldRef(t, 'i2'); }
	/** std::swap / std::exchange / release through references. */
	static swap(a, b) { const t = a.get(); a.set(b.get()); b.set(t); }
	static exchange(a, v) { const old = a.get(); a.set(v); return old; }
	static release(a) { const r = a.get(); a.set(null); return r; }
	static iabs_i(x) { return x < 0 ? (-x) | 0 : x; }
	static iabs_l(x) { return x < 0 ? canonL(-BigInt(x)) : x; }
	static Nop(x) { return 0; }
	/** Comparing a std::optional with nullopt, another optional or a value (op "==" or "!="). */
	static OptCmp(a, b, op) {
		let eq;
		if (b === null || b === undefined) eq = !a.has;
		else if (b instanceof cpp.Opt) eq = a.has === b.has && (!a.has || eqDefault(a.val, b.val));
		else eq = a.has && eqDefault(a.val, b);
		return op === '==' ? eq : !eq;
	}

	/** std::from_chars for double (chars_format::general), as libstdc++ has it: the value strtod reads from the same
	 *  characters (both are correctly rounded), except that a sign other than '-', leading white space and a
	 *  hexadecimal prefix are not read ("0x10" is 0 and stops at the x), and a value too large or too small for a
	 *  double is result_out_of_range (34) with the value left unchanged. The C# runtime does not make the last two
	 *  distinctions (it would read "0x10" as hexadecimal and store an overflowed or underflowed value); libstdc++ is
	 *  followed, as in the Go and Java ports. */
	static from_chars_CPtr_CPtr_dr(first, last, v) {
		const n = last.O - first.O;
		const tmp = new Uint8Array(Math.max(n, 0) + 2);
		const B = first.B;
		for (let i = 0; i < n; i++) tmp[i] = B[first.O + i] & 255;
		const k = tmp[0] === 45 ? 1 : 0;
		const c = tmp[k];
		const lc = c >= 65 && c <= 90 ? c | 0x20 : c;
		if (!((c >= 48 && c <= 57) || c === 46 || lc === 105 || lc === 110)) return new FromCharsResult(first, 22);
		if (c === 48 && (tmp[k + 1] | 0x20) === 120) tmp[k + 1] = 0;   // read the 0 alone
		const p = new cpp.CPtr(tmp, 0);
		const end = new LocalRef(p);
		const r = R.strtod_CPtr_CPtrr(p, end);
		const used = end.v.O;
		if (used === 0) return new FromCharsResult(first, 22);
		const ptr = new cpp.CPtr(first.B, first.O + used);
		if ((r === Infinity || r === -Infinity) && lc !== 105) return new FromCharsResult(ptr, 34);   // overflow
		if (r === 0) {                                     // underflow: a nonzero digit before the exponent
			for (let j = k; j < used; j++) {
				const d = tmp[j];
				if (d === 101 || d === 69) break;
				if (d >= 49 && d <= 57) return new FromCharsResult(ptr, 34);
			}
		}
		v.set(r);
		return new FromCharsResult(ptr, 0);
	}
	static from_chars_CPtr_CPtr_ir(first, last, v) {
		const r = intChars(first, last, true, -2147483648n, 2147483647n);
		if (icOk) v.set(Number(icVal));
		return r;
	}
	static from_chars_CPtr_CPtr_lr(first, last, v) {
		const r = intChars(first, last, true, -9223372036854775808n, 9223372036854775807n);
		if (icOk) v.set(canonL(icVal));
		return r;
	}
	static from_chars_CPtr_CPtr_ur(first, last, v) {
		const r = intChars(first, last, false, 0n, 4294967295n);
		if (icOk) v.set(Number(icVal));
		return r;
	}
	static from_chars_CPtr_CPtr_ulr(first, last, v) {
		const r = intChars(first, last, false, 0n, 18446744073709551615n);
		if (icOk) v.set(canonUL(icVal));
		return r;
	}
}
// std::from_chars for integers, base 10: an optional '-' (signed types only), digits; an empty match is
// invalid_argument (22) with ptr = first; a value out of the type's range is result_out_of_range (34), all the
// digits consumed, the value left unchanged
let icOk = false;
let icVal = 0n;
function intChars(first, last, signed, lo, hi) {
	const B = first.B;
	let i = first.O;
	icOk = false;
	let neg = false;
	if (signed && i < last.O && (B[i] & 255) === 45) { neg = true; i++; }
	const start = i;
	let mag = 0, magB = 0n, big = false;
	for (let c; i < last.O && (c = B[i] & 255) >= 48 && c <= 57; i++) {
		if (!big) { if (mag < 900719925474099) mag = mag * 10 + (c - 48); else { big = true; magB = BigInt(mag) * 10n + BigInt(c - 48); } }
		else if (magB <= 18446744073709551616n) magB = magB * 10n + BigInt(c - 48);
	}
	if (i === start) return new FromCharsResult(first, 22);
	const end = new cpp.CPtr(B, i);
	let r = big ? magB : BigInt(mag);
	if (neg) r = -r;
	if (r < lo || r > hi) return new FromCharsResult(end, 34);
	icVal = r;
	icOk = true;
	return new FromCharsResult(end, 0);
}

/** std::from_chars_result (C# Cpp.FromCharsResult): where parsing stopped and the error (0, EINVAL 22 or ERANGE 34).
 *  A C# struct, so an immutable value with a ZERO default. */
export class FromCharsResult {
	ptr;
	ec;
	constructor(ptr = null, ec = 0) { this.ptr = ptr === null ? cpp.CPtr.ZERO : ptr; this.ec = ec; }
	Clone() { return this; }
	static zero = null;
	static get ZERO() {
		if (FromCharsResult.zero === null) FromCharsResult.zero = new FromCharsResult(null, 0);
		return FromCharsResult.zero;
	}
}

/** std::error_code (C# Cpp.ErrorCode): the errno value a filesystem call set. */
export class ErrorCode {
	v = 0;
	Bool() { return this.v !== 0; }
	value() { return this.v; }
	clear() { this.v = 0; }
	/** glibc's strerror text for the errno values the filesystem calls set. */
	message() {
		let m;
		switch (this.v) {
			case 0: m = 'Success'; break;
			case 2: m = 'No such file or directory'; break;
			case 13: m = 'Permission denied'; break;
			case 17: m = 'File exists'; break;
			case 20: m = 'Not a directory'; break;
			case 21: m = 'Is a directory'; break;
			case 95: m = 'Operation not supported'; break;
			default: m = 'Unknown error ' + this.v;
		}
		return cpp.Str.new_CPtr(R.Lit(m));
	}
}

// ------------------------------------------------------------------------------------------------ atomics, locks

/** Wrapping integer and IEEE arithmetic on a value of the type the code names (std::atomic's fetch_add; C#'s
 *  Num.Add / Num.Sub support int, long, ulong, uint and double and throw NotSupportedException otherwise). */
function numAdd(code, a, b) {
	switch (code) {
		case 'i': return (a + b) | 0;
		case 'u': return (a + b) >>> 0;
		case 'l': return addL(a, b);
		case 'ul': return addUL(a, b);
		case 'd': return a + b;
	}
	throw new SysException('NotSupportedException', 'atomic add on ' + code);
}
function numSub(code, a, b) {
	switch (code) {
		case 'i': return (a - b) | 0;
		case 'u': return (a - b) >>> 0;
		case 'l': return subL(a, b);
		case 'ul': return subUL(a, b);
		case 'd': return a - b;
	}
	throw new SysException('NotSupportedException', 'atomic sub on ' + code);
}

/** std::atomic<T> on one thread (C# Cpp.Atomic<T>). compare_exchange compares as C#'s EqualityComparer<T>.Default
 *  does. The constructors take T's maker last, as ts/RUNTIME_HELPERS.md says. */
export class Atomic {
	v;
	constructor(mk) { this.v = mk ? mk() : null; }
	static new_T(x, mk) { const a = new Atomic(); a.v = x; return a; }
	exchange(x) { const o = this.v; this.v = x; return o; }
	load(order = 0) { return this.v; }
	store(x, order = 0) { this.v = x; }
	fetch_add__i(d, order = 0) { const o = this.v; this.v = numAdd('i', o, d); return o; }
	fetch_add__u(d, order = 0) { const o = this.v; this.v = numAdd('u', o, d); return o; }
	fetch_add__l(d, order = 0) { const o = this.v; this.v = numAdd('l', o, d); return o; }
	fetch_add__ul(d, order = 0) { const o = this.v; this.v = numAdd('ul', o, d); return o; }
	fetch_add__s(d, order = 0) { const o = this.v; this.v = numAdd('s', o, d); return o; }
	fetch_add__us(d, order = 0) { const o = this.v; this.v = numAdd('us', o, d); return o; }
	fetch_add__c(d, order = 0) { const o = this.v; this.v = numAdd('c', o, d); return o; }
	fetch_add__uc(d, order = 0) { const o = this.v; this.v = numAdd('uc', o, d); return o; }
	fetch_add__ch(d, order = 0) { const o = this.v; this.v = numAdd('ch', o, d); return o; }
	fetch_add__b(d, order = 0) { const o = this.v; this.v = numAdd('b', o, d); return o; }
	fetch_add__f(d, order = 0) { const o = this.v; this.v = numAdd('f', o, d); return o; }
	fetch_add__d(d, order = 0) { const o = this.v; this.v = numAdd('d', o, d); return o; }
	fetch_sub__i(d, order = 0) { const o = this.v; this.v = numSub('i', o, d); return o; }
	fetch_sub__u(d, order = 0) { const o = this.v; this.v = numSub('u', o, d); return o; }
	fetch_sub__l(d, order = 0) { const o = this.v; this.v = numSub('l', o, d); return o; }
	fetch_sub__ul(d, order = 0) { const o = this.v; this.v = numSub('ul', o, d); return o; }
	fetch_sub__s(d, order = 0) { const o = this.v; this.v = numSub('s', o, d); return o; }
	fetch_sub__us(d, order = 0) { const o = this.v; this.v = numSub('us', o, d); return o; }
	fetch_sub__c(d, order = 0) { const o = this.v; this.v = numSub('c', o, d); return o; }
	fetch_sub__uc(d, order = 0) { const o = this.v; this.v = numSub('uc', o, d); return o; }
	fetch_sub__ch(d, order = 0) { const o = this.v; this.v = numSub('ch', o, d); return o; }
	fetch_sub__b(d, order = 0) { const o = this.v; this.v = numSub('b', o, d); return o; }
	fetch_sub__f(d, order = 0) { const o = this.v; this.v = numSub('f', o, d); return o; }
	fetch_sub__d(d, order = 0) { const o = this.v; this.v = numSub('d', o, d); return o; }
	/** compare_exchange_weak / strong on one thread: never fails spuriously. */
	compare_exchange(expected, desired) {
		if (eqDefault(this.v, expected.get())) { this.v = desired; return true; }
		expected.set(this.v);
		return false;
	}
	Clone() { return Atomic.new_T(this.v); }
	Assign(o) { this.v = o.v; }
}
/** Wrapping integer and IEEE arithmetic on a generic value (C# Cpp.Num, std::atomic's fetch_add). */
export class Num {
	static Add__i(a, b) { return numAdd('i', a, b); }
	static Add__u(a, b) { return numAdd('u', a, b); }
	static Add__l(a, b) { return numAdd('l', a, b); }
	static Add__ul(a, b) { return numAdd('ul', a, b); }
	static Add__s(a, b) { return numAdd('s', a, b); }
	static Add__us(a, b) { return numAdd('us', a, b); }
	static Add__c(a, b) { return numAdd('c', a, b); }
	static Add__uc(a, b) { return numAdd('uc', a, b); }
	static Add__ch(a, b) { return numAdd('ch', a, b); }
	static Add__b(a, b) { return numAdd('b', a, b); }
	static Add__f(a, b) { return numAdd('f', a, b); }
	static Add__d(a, b) { return numAdd('d', a, b); }
	static Sub__i(a, b) { return numSub('i', a, b); }
	static Sub__u(a, b) { return numSub('u', a, b); }
	static Sub__l(a, b) { return numSub('l', a, b); }
	static Sub__ul(a, b) { return numSub('ul', a, b); }
	static Sub__s(a, b) { return numSub('s', a, b); }
	static Sub__us(a, b) { return numSub('us', a, b); }
	static Sub__c(a, b) { return numSub('c', a, b); }
	static Sub__uc(a, b) { return numSub('uc', a, b); }
	static Sub__ch(a, b) { return numSub('ch', a, b); }
	static Sub__b(a, b) { return numSub('b', a, b); }
	static Sub__f(a, b) { return numSub('f', a, b); }
	static Sub__d(a, b) { return numSub('d', a, b); }
}

/** The ports run single-threaded: the engine's one worker thread (the output writer, IOThread) is replaced by a
 *  synchronous call (cs/runtime/Hand_IOThread.cs), so these never block. */
export class Mutex { }
export class CondVar { }
export class Lock { }
/** std::thread: never joinable. */
export class Thread {
	joinable() { return false; }
	join() { }
}
/** std::once_flag: whether call_once has run its function. */
export class OnceFlag { done = false; }
export class StdOnce { }

/** std::tuple of two or three elements (C# Cpp.Tup<A, B> and Tup<A, B, C>, which TypeScript names alike): the
 *  parameterless constructor takes one maker per element. */
export class Tup {
	i0; i1; i2;
	constructor(mkA, mkB, mkC) {
		this.i0 = mkA ? mkA() : null;
		this.i1 = mkB ? mkB() : null;
		this.i2 = mkC ? mkC() : null;
		this.n = mkC ? 3 : 2;
	}
	n;
	static new_A_B(a, b) { const t = new Tup(); t.i0 = a; t.i1 = b; return t; }
	static new_A_B_C(a, b, c) { const t = new Tup(); t.i0 = a; t.i1 = b; t.i2 = c; t.n = 3; return t; }
	Clone() {
		const t = new Tup();
		t.i0 = elemCopy(this.i0); t.i1 = elemCopy(this.i1); t.n = this.n;
		if (this.n === 3) t.i2 = elemCopy(this.i2);
		return t;
	}
	Assign(o) { this.i0 = elemCopy(o.i0); this.i1 = elemCopy(o.i1); if (o.n === 3) this.i2 = elemCopy(o.i2); }
}

// ------------------------------------------------------------------------------------------------ raw memory

const ESZ = { i: 4, u: 4, l: 8, ul: 8, s: 2, us: 2, c: 1, uc: 1, ch: 2, b: 1, f: 4, d: 8 };
/** The default (zero) element of the type the code names. */
function zeroOf(code) { return code === 'b' ? false : 0; }
/** Element value v at byte k of dv, little-endian. */
function enc(dv, k, code, v) {
	switch (code) {
		case 'd': dv.setFloat64(k, v, true); return;
		case 'f': dv.setFloat32(k, v, true); return;
		case 'i': dv.setInt32(k, v, true); return;
		case 'u': dv.setUint32(k, v, true); return;
		case 'l': case 'ul':
			if (typeof v === 'number') {
				const hi = Math.floor(v / 4294967296);
				dv.setUint32(k, v - hi * 4294967296, true);
				dv.setInt32(k + 4, hi, true);
			} else dv.setBigUint64(k, BigInt.asUintN(64, v), true);
			return;
		case 's': dv.setInt16(k, v, true); return;
		case 'us': case 'ch': dv.setUint16(k, v, true); return;
		case 'c': dv.setInt8(k, v); return;
		case 'uc': dv.setUint8(k, v); return;
		case 'b': dv.setUint8(k, v ? 1 : 0); return;
	}
	throw new SysException('NotSupportedException', 'raw memory of type code ' + code);
}
/** The element at byte k of dv, little-endian, in its canonical TypeScript form. */
function decv(dv, k, code) {
	switch (code) {
		case 'd': return dv.getFloat64(k, true);
		case 'f': return dv.getFloat32(k, true);
		case 'i': return dv.getInt32(k, true);
		case 'u': return dv.getUint32(k, true);
		case 'l': {
			const hi = dv.getInt32(k + 4, true), lo = dv.getUint32(k, true);
			if ((hi > -2097152 && hi < 2097152) || (hi === -2097152 && lo !== 0)) return hi * 4294967296 + lo;
			return dv.getBigInt64(k, true);
		}
		case 'ul': {
			const hi = dv.getUint32(k + 4, true), lo = dv.getUint32(k, true);
			if (hi < 2097152) return hi * 4294967296 + lo;
			return dv.getBigUint64(k, true);
		}
		case 's': return dv.getInt16(k, true);
		case 'us': case 'ch': return dv.getUint16(k, true);
		case 'c': return dv.getInt8(k);
		case 'uc': return dv.getUint8(k);
		case 'b': return dv.getUint8(k) !== 0;
	}
	throw new SysException('NotSupportedException', 'raw memory of type code ' + code);
}
function outOfRange() { return new SysException('ArgumentOutOfRangeException', 'Specified argument was out of the range of valid values.'); }
// one element's bytes (scratch for readBytes / writeBytes)
const SB = new Uint8Array(8);
const SDV = new DataView(SB.buffer);
// A null pointer with no bytes is no bytes (C# Mem.Bytes): libstdc++ passes the data() of an empty vector, which is
// nullptr (Vec.data), with a length of 0 (os.write(v.data(), 0), memcpy(d, s, 0)); readBytes, writeBytes, cBytes and
// cWrite accept it, and so every helper built on them does.
/** n bytes of the array a from element o (C#'s MemoryMarshal.AsBytes of the span from o to the end, sliced): a
 *  fresh array. */
function readBytes(a, o, code, n) {
	if (a == null && n === 0) return new Uint8Array(0);
	const sz = ESZ[code];
	if (n < 0 || o < 0 || n > (a.length - o) * sz) throw outOfRange();
	const out = new Uint8Array(n);
	for (let k = 0, e = o; k < n; e++) {
		enc(SDV, 0, code, a[e]);
		const r = n - k < sz ? n - k : sz;
		for (let j = 0; j < r; j++) out[k + j] = SB[j];
		k += r;
	}
	return out;
}
/** n bytes of src from soff into the array a from element o (a partial last element keeps its other bytes). */
function writeBytes(a, o, code, src, soff, n) {
	if (a == null && n === 0) return;
	const sz = ESZ[code];
	if (n < 0 || o < 0 || n > (a.length - o) * sz) throw outOfRange();
	for (let k = 0, e = o; k < n; e++) {
		const r = n - k < sz ? n - k : sz;
		if (r < sz) enc(SDV, 0, code, a[e]);
		for (let j = 0; j < r; j++) SB[j] = src[soff + k + j];   // a Uint8Array keeps the low byte of a signed one
		a[e] = decv(SDV, 0, code);
		k += r;
	}
}
/** The bytes of the C string p from its offset (a view or copy of n of them). */
function cBytes(p, n) {
	const B = p.B;
	if (B == null && n === 0) return new Uint8Array(0);
	if (n < 0 || p.O < 0 || p.O + n > B.length) throw outOfRange();
	if (B instanceof Uint8Array) return B.subarray(p.O, p.O + n);
	const r = new Uint8Array(n);
	for (let k = 0; k < n; k++) r[k] = B[p.O + k] & 255;
	return r;
}
/** n bytes into the C string p at its offset. */
function cWrite(p, src, n) {
	const B = p.B;
	if (B == null && n === 0) return;
	if (n < 0 || p.O < 0 || p.O + n > B.length) throw outOfRange();
	if (B instanceof Uint8Array) { B.set(src.subarray(0, n), p.O); return; }
	for (let k = 0; k < n; k++) p.set(k, src[k]);
}
// A pointer's array and offset. A pointer to a field (&obj.field: cpp.Ptr's ob and at, no array) is seen as a
// one-element array: fieldArr reads the field into a fresh array, fieldBack stores element 0 back.
function pa(p) { const q = p; return q.at != null ? [q.at(q.ob).get()] : q.a; }
function po(p) { const q = p; return q.at != null ? 0 : ix(q.o); }
function writeBytesP(p, code, src, soff, n) {
	const q = p;
	if (q.at != null) { const r = q.at(q.ob), t = [r.get()]; writeBytes(t, 0, code, src, soff, n); r.set(t[0]); return; }
	writeBytes(q.a, ix(q.o), code, src, soff, n);
}

function calloc(n, size, code) {
	const bytes = BigInt.asUintN(64, BigInt(n) * BigInt(size));
	const cnt = toI32(bytes / BigInt(ESZ[code]));
	const a = new Array(Math.max(cnt, 0)).fill(zeroOf(code));
	return cpp.Ptr.new_TA_l(a, 0);
}
function copyFromC(d, code, s, n) {
	const m = ix(n);
	const q = d, B = s.B;
	if (q.at == null) {                    // straight from the C string's bytes (a null one has none)
		if (m < 0 || s.O < 0 || s.O + m > (B == null ? 0 : B.length)) throw outOfRange();
		writeBytes(q.a, ix(q.o), code, B, s.O, m);
		return;
	}
	writeBytesP(d, code, cBytes(s, m), 0, m);
}
function copyToC(d, s, code, n) {
	const m = ix(n);
	cWrite(d, readBytes(pa(s), po(s), code, m), m);
}
function copyTT(d, dc, s, sc, n) {
	const m = ix(n);
	if (m === 0) return;
	writeBytesP(d, dc, readBytes(pa(s), po(s), sc, m), 0, m);
}
function fillT(d, code, v, n) {
	const m = ix(n);
	writeBytesP(d, code, new Uint8Array(m).fill(v & 255), 0, m);
}
/** fwrite of size*count bytes from a typed pointer; returns count. */
function fwriteT(p, code, size, count, f) {
	const b = readBytes(pa(p), po(p), code, ix(BigInt.asUintN(64, BigInt(size) * BigInt(count))));
	f.S.Write(b, 0, b.length);
	return count;
}
/** fread of size*count bytes into a typed pointer: the bytes read are copied in (a partial element too); the number
 *  of whole items read; a short read sets the end-of-file flag. */
function freadT(p, code, size, count, f) {
	const want = ix(BigInt.asUintN(64, BigInt(size) * BigInt(count)));
	const b = new Uint8Array(want);
	let got = 0;
	while (got < want) { const k = f.S.Read(b, got, want - got); if (k <= 0) break; got += k; }
	if (got < want) f.ReadFailed();
	writeBytesP(p, code, b, 0, got);
	return size == 0 ? 0 : canonUL(BigInt(got) / BigInt.asUintN(64, BigInt(size)));
}
function ptrBytes(p, code, n) { return readBytes(pa(p), po(p), code, n).slice(); }
function intoPtr(p, code, src, off, n) { writeBytesP(p, code, src, off, n); }
/** The bytes of the numbers p points at, from p to the end of its array, as a char* for reading (a copy); the
 *  char* of a null pointer is null. */
function viewOf(p, code) {
	if (p.get_IsNull()) return cpp.CPtr.ZERO;
	const a = pa(p), o = po(p);
	return new cpp.CPtr(readBytes(a, o, code, (a.length - o) * ESZ[code]), 0);
}

/** Raw memory on typed arrays (C# Cpp.Mem): calloc, memcpy and memset across element types, fread / fwrite of
 *  typed arrays, and the index of an object in an array of objects. */
export class Mem {
	/** calloc(n, size) cast to T*: n*size bytes of zeroed T. Zero bytes give an empty array, which, like glibc's
	 *  unique pointer for a zero-size request, is never dereferenced. free() is the collector's. */
	static Calloc__i(n, size) { return calloc(n, size, 'i'); }
	static Calloc__u(n, size) { return calloc(n, size, 'u'); }
	static Calloc__l(n, size) { return calloc(n, size, 'l'); }
	static Calloc__ul(n, size) { return calloc(n, size, 'ul'); }
	static Calloc__s(n, size) { return calloc(n, size, 's'); }
	static Calloc__us(n, size) { return calloc(n, size, 'us'); }
	static Calloc__c(n, size) { return calloc(n, size, 'c'); }
	static Calloc__uc(n, size) { return calloc(n, size, 'uc'); }
	static Calloc__ch(n, size) { return calloc(n, size, 'ch'); }
	static Calloc__b(n, size) { return calloc(n, size, 'b'); }
	static Calloc__f(n, size) { return calloc(n, size, 'f'); }
	static Calloc__d(n, size) { return calloc(n, size, 'd'); }
	static Free(p) { }
	/** &obj - p: the index of an object in an array of objects (pointers to objects are references). */
	static Diff_T_PtrT(obj, p) { return pa(p).indexOf(obj) - po(p); }
	static Diff_PtrT_T(p, obj) { return po(p) - pa(p).indexOf(obj); }
	// memcpy<T, U>(T* d, U* s, n): through a byte copy, so overlapping arrays behave as memmove (the codes are the
	// destination's, then the source's)
	static memcpy_PtrT_PtrU_ul__u_uc(d, s, n) { copyTT(d, 'u', s, 'uc', n); return d; }
	static memcpy_PtrT_PtrU_ul__uc_u(d, s, n) { copyTT(d, 'uc', s, 'u', n); return d; }
	static memcpy_PtrT_PtrU_ul__ul_d(d, s, n) { copyTT(d, 'ul', s, 'd', n); return d; }
	static memcpy_PtrT_PtrU_ul__d_ul(d, s, n) { copyTT(d, 'd', s, 'ul', n); return d; }
	static memcpy_PtrT_PtrU_ul__l_d(d, s, n) { copyTT(d, 'l', s, 'd', n); return d; }
	static memcpy_PtrT_PtrU_ul__d_l(d, s, n) { copyTT(d, 'd', s, 'l', n); return d; }
	static memcpy_PtrT_PtrU_ul__i_uc(d, s, n) { copyTT(d, 'i', s, 'uc', n); return d; }
	static memcpy_PtrT_PtrU_ul__uc_i(d, s, n) { copyTT(d, 'uc', s, 'i', n); return d; }
	static memcpy_PtrT_PtrU_ul__u_f(d, s, n) { copyTT(d, 'u', s, 'f', n); return d; }
	static memcpy_PtrT_PtrU_ul__f_u(d, s, n) { copyTT(d, 'f', s, 'u', n); return d; }
	/** Any memcpy<T, U>: the destination's and source's type codes, then the arguments. */
	static memcpyCodes(dc, sc, d, s, n) { copyTT(d, dc, s, sc, n); return d; }
	// memcpy<T>(T* d, const char* s, n), memcpy<U>(char* d, const U* s, n), memset<T>(T* d, c, n)
	static memcpy_PtrT_CPtr_ul__i(d, s, n) { copyFromC(d, 'i', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__u(d, s, n) { copyFromC(d, 'u', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__l(d, s, n) { copyFromC(d, 'l', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__ul(d, s, n) { copyFromC(d, 'ul', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__s(d, s, n) { copyFromC(d, 's', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__us(d, s, n) { copyFromC(d, 'us', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__c(d, s, n) { copyFromC(d, 'c', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__uc(d, s, n) { copyFromC(d, 'uc', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__ch(d, s, n) { copyFromC(d, 'ch', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__b(d, s, n) { copyFromC(d, 'b', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__f(d, s, n) { copyFromC(d, 'f', s, n); return d; }
	static memcpy_PtrT_CPtr_ul__d(d, s, n) { copyFromC(d, 'd', s, n); return d; }
	static memcpy_CPtr_PtrU_ul__i(d, s, n) { copyToC(d, s, 'i', n); return d; }
	static memcpy_CPtr_PtrU_ul__u(d, s, n) { copyToC(d, s, 'u', n); return d; }
	static memcpy_CPtr_PtrU_ul__l(d, s, n) { copyToC(d, s, 'l', n); return d; }
	static memcpy_CPtr_PtrU_ul__ul(d, s, n) { copyToC(d, s, 'ul', n); return d; }
	static memcpy_CPtr_PtrU_ul__s(d, s, n) { copyToC(d, s, 's', n); return d; }
	static memcpy_CPtr_PtrU_ul__us(d, s, n) { copyToC(d, s, 'us', n); return d; }
	static memcpy_CPtr_PtrU_ul__c(d, s, n) { copyToC(d, s, 'c', n); return d; }
	static memcpy_CPtr_PtrU_ul__uc(d, s, n) { copyToC(d, s, 'uc', n); return d; }
	static memcpy_CPtr_PtrU_ul__ch(d, s, n) { copyToC(d, s, 'ch', n); return d; }
	static memcpy_CPtr_PtrU_ul__b(d, s, n) { copyToC(d, s, 'b', n); return d; }
	static memcpy_CPtr_PtrU_ul__f(d, s, n) { copyToC(d, s, 'f', n); return d; }
	static memcpy_CPtr_PtrU_ul__d(d, s, n) { copyToC(d, s, 'd', n); return d; }
	static memset_PtrT_i_ul__i(d, v, n) { fillT(d, 'i', v, n); return d; }
	static memset_PtrT_i_ul__u(d, v, n) { fillT(d, 'u', v, n); return d; }
	static memset_PtrT_i_ul__l(d, v, n) { fillT(d, 'l', v, n); return d; }
	static memset_PtrT_i_ul__ul(d, v, n) { fillT(d, 'ul', v, n); return d; }
	static memset_PtrT_i_ul__s(d, v, n) { fillT(d, 's', v, n); return d; }
	static memset_PtrT_i_ul__us(d, v, n) { fillT(d, 'us', v, n); return d; }
	static memset_PtrT_i_ul__c(d, v, n) { fillT(d, 'c', v, n); return d; }
	static memset_PtrT_i_ul__uc(d, v, n) { fillT(d, 'uc', v, n); return d; }
	static memset_PtrT_i_ul__ch(d, v, n) { fillT(d, 'ch', v, n); return d; }
	static memset_PtrT_i_ul__b(d, v, n) { fillT(d, 'b', v, n); return d; }
	static memset_PtrT_i_ul__f(d, v, n) { fillT(d, 'f', v, n); return d; }
	static memset_PtrT_i_ul__d(d, v, n) { fillT(d, 'd', v, n); return d; }
	static memcpy_CPtr_CPtr_ul(d, s, n) {
		const m = ix(n);
		const B = s.B;
		if (m === 0) return d;
		if (m < 0 || s.O + m > B.length) throw outOfRange();
		const t = B instanceof Uint8Array ? B.slice(s.O, s.O + m) : cBytes(s, m);   // a copy: Array.Copy handles overlap
		cWrite(d, t, m);
		return d;
	}
	static memset_CPtr_i_ul(d, c, n) {
		const m = ix(n);
		const B = d.B;
		if (m < 0 || d.O + m > (B == null ? 0 : B.length)) throw outOfRange();
		if (B instanceof Uint8Array) B.fill(c & 255, d.O, d.O + m);
		else for (let k = 0; k < m; k++) d.set(k, c & 255);
		return d;
	}
	// fwrite / fread of typed pointers, and the bytes of typed pointers (C#'s BytesOf / BytesInto)
	static fwrite_PtrT_ul_ul_CFile__i(p, size, count, f) { return fwriteT(p, 'i', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__u(p, size, count, f) { return fwriteT(p, 'u', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__l(p, size, count, f) { return fwriteT(p, 'l', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__ul(p, size, count, f) { return fwriteT(p, 'ul', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__s(p, size, count, f) { return fwriteT(p, 's', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__us(p, size, count, f) { return fwriteT(p, 'us', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__c(p, size, count, f) { return fwriteT(p, 'c', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__uc(p, size, count, f) { return fwriteT(p, 'uc', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__ch(p, size, count, f) { return fwriteT(p, 'ch', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__b(p, size, count, f) { return fwriteT(p, 'b', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__f(p, size, count, f) { return fwriteT(p, 'f', size, count, f); }
	static fwrite_PtrT_ul_ul_CFile__d(p, size, count, f) { return fwriteT(p, 'd', size, count, f); }
	static fread_PtrT_ul_ul_CFile__i(p, size, count, f) { return freadT(p, 'i', size, count, f); }
	static fread_PtrT_ul_ul_CFile__u(p, size, count, f) { return freadT(p, 'u', size, count, f); }
	static fread_PtrT_ul_ul_CFile__l(p, size, count, f) { return freadT(p, 'l', size, count, f); }
	static fread_PtrT_ul_ul_CFile__ul(p, size, count, f) { return freadT(p, 'ul', size, count, f); }
	static fread_PtrT_ul_ul_CFile__s(p, size, count, f) { return freadT(p, 's', size, count, f); }
	static fread_PtrT_ul_ul_CFile__us(p, size, count, f) { return freadT(p, 'us', size, count, f); }
	static fread_PtrT_ul_ul_CFile__c(p, size, count, f) { return freadT(p, 'c', size, count, f); }
	static fread_PtrT_ul_ul_CFile__uc(p, size, count, f) { return freadT(p, 'uc', size, count, f); }
	static fread_PtrT_ul_ul_CFile__ch(p, size, count, f) { return freadT(p, 'ch', size, count, f); }
	static fread_PtrT_ul_ul_CFile__b(p, size, count, f) { return freadT(p, 'b', size, count, f); }
	static fread_PtrT_ul_ul_CFile__f(p, size, count, f) { return freadT(p, 'f', size, count, f); }
	static fread_PtrT_ul_ul_CFile__d(p, size, count, f) { return freadT(p, 'd', size, count, f); }
	static BytesOf__i(p, n) { return ptrBytes(p, 'i', n); }
	static BytesOf__u(p, n) { return ptrBytes(p, 'u', n); }
	static BytesOf__l(p, n) { return ptrBytes(p, 'l', n); }
	static BytesOf__ul(p, n) { return ptrBytes(p, 'ul', n); }
	static BytesOf__s(p, n) { return ptrBytes(p, 's', n); }
	static BytesOf__us(p, n) { return ptrBytes(p, 'us', n); }
	static BytesOf__c(p, n) { return ptrBytes(p, 'c', n); }
	static BytesOf__uc(p, n) { return ptrBytes(p, 'uc', n); }
	static BytesOf__ch(p, n) { return ptrBytes(p, 'ch', n); }
	static BytesOf__b(p, n) { return ptrBytes(p, 'b', n); }
	static BytesOf__f(p, n) { return ptrBytes(p, 'f', n); }
	static BytesOf__d(p, n) { return ptrBytes(p, 'd', n); }
	static BytesInto__i(p, src, off, n) { intoPtr(p, 'i', src, off, n); }
	static BytesInto__u(p, src, off, n) { intoPtr(p, 'u', src, off, n); }
	static BytesInto__l(p, src, off, n) { intoPtr(p, 'l', src, off, n); }
	static BytesInto__ul(p, src, off, n) { intoPtr(p, 'ul', src, off, n); }
	static BytesInto__s(p, src, off, n) { intoPtr(p, 's', src, off, n); }
	static BytesInto__us(p, src, off, n) { intoPtr(p, 'us', src, off, n); }
	static BytesInto__c(p, src, off, n) { intoPtr(p, 'c', src, off, n); }
	static BytesInto__uc(p, src, off, n) { intoPtr(p, 'uc', src, off, n); }
	static BytesInto__ch(p, src, off, n) { intoPtr(p, 'ch', src, off, n); }
	static BytesInto__b(p, src, off, n) { intoPtr(p, 'b', src, off, n); }
	static BytesInto__f(p, src, off, n) { intoPtr(p, 'f', src, off, n); }
	static BytesInto__d(p, src, off, n) { intoPtr(p, 'd', src, off, n); }
	static fwrite_CPtr_ul_ul_CFile(p, size, count, f) {
		const n = ix(BigInt.asUintN(64, BigInt(size) * BigInt(count)));
		if (n !== 0) f.S.Write(p.B, p.O, n);
		return count;
	}
	static fread_CPtr_ul_ul_CFile(p, size, count, f) {
		const want = ix(BigInt.asUintN(64, BigInt(size) * BigInt(count)));
		const B = p.B;
		let got = 0;
		if (B instanceof Uint8Array) {
			while (got < want) { const k = f.S.Read(B, p.O + got, want - got); if (k <= 0) break; got += k; }
		} else {
			const t = new Uint8Array(want);
			while (got < want) { const k = f.S.Read(t, got, want - got); if (k <= 0) break; got += k; }
			for (let k = 0; k < got; k++) p.set(k, t[k]);
		}
		if (got < want) f.ReadFailed();
		return size == 0 ? 0 : canonUL(BigInt(got) / BigInt.asUintN(64, BigInt(size)));
	}
}

/** The bytes of the numbers a pointer addresses, as a char* for reading (C# Cpp.Bytes): a copy of the little-endian
 *  bytes from the pointer to the end of its array (C#'s MemoryMarshal.AsBytes view); a null pointer (the data() of
 *  an empty vector) gives a null char*. */
export class Bytes {
	static View_CPtr(p) { return p; }
	static View_PtrT__i(p) { return viewOf(p, 'i'); }
	static View_PtrT__u(p) { return viewOf(p, 'u'); }
	static View_PtrT__l(p) { return viewOf(p, 'l'); }
	static View_PtrT__ul(p) { return viewOf(p, 'ul'); }
	static View_PtrT__s(p) { return viewOf(p, 's'); }
	static View_PtrT__us(p) { return viewOf(p, 'us'); }
	static View_PtrT__c(p) { return viewOf(p, 'c'); }
	static View_PtrT__uc(p) { return viewOf(p, 'uc'); }
	static View_PtrT__ch(p) { return viewOf(p, 'ch'); }
	static View_PtrT__b(p) { return viewOf(p, 'b'); }
	static View_PtrT__f(p) { return viewOf(p, 'f'); }
	static View_PtrT__d(p) { return viewOf(p, 'd'); }
}

/** std::bit_cast between doubles and 64-bit integers and between floats and 32-bit integers (C# Cpp.Bits.Cast<T>:
 *  the code is T's; the argument is the source value: a double for ulong and long, a long or ulong for double, a
 *  float for uint, a uint for float). */
function bitCast(code, x) {
	switch (code) {
		case 'ul': case 'l': {
			if (typeof x !== 'number') break;
			F64[0] = x;
			const hi = W32[1], lo = W32[0];
			const b = (BigInt(hi) << 32n) | BigInt(lo);
			return code === 'ul' ? canonUL(b) : canonL(b);
		}
		case 'd': {
			if (typeof x !== 'number' && typeof x !== 'bigint') break;
			const b = BigInt.asUintN(64, BigInt(x));
			W32[1] = Number(b >> 32n); W32[0] = Number(b & 0xffffffffn);
			return F64[0];
		}
		case 'u': {
			if (typeof x !== 'number') break;
			const f = new Float32Array([x]);
			return new Uint32Array(f.buffer)[0];
		}
		case 'f': {
			if (typeof x !== 'number') break;
			const u = new Uint32Array([x >>> 0]);
			return new Float32Array(u.buffer)[0];
		}
	}
	throw new SysException('NotSupportedException', 'bit_cast ' + typeof x + ' -> ' + code);
}
export class Bits {
	static Cast__i(x) { return bitCast('i', x); }
	static Cast__u(x) { return bitCast('u', x); }
	static Cast__l(x) { return bitCast('l', x); }
	static Cast__ul(x) { return bitCast('ul', x); }
	static Cast__s(x) { return bitCast('s', x); }
	static Cast__us(x) { return bitCast('us', x); }
	static Cast__c(x) { return bitCast('c', x); }
	static Cast__uc(x) { return bitCast('uc', x); }
	static Cast__ch(x) { return bitCast('ch', x); }
	static Cast__b(x) { return bitCast('b', x); }
	static Cast__f(x) { return bitCast('f', x); }
	static Cast__d(x) { return bitCast('d', x); }
}

// ------------------------------------------------------------------------------------------------ std::chrono

const T0 = process.hrtime.bigint();

/** A std::chrono time point (C# Cpp.TimePoint): nanoseconds of a monotonic clock (here since the runtime loaded).
 *  Used only for timing. A C# struct, so an immutable value. */
export class TimePoint {
	ns;
	constructor(ns = 0) { this.ns = ns; }
	static ZERO = new TimePoint(0);
	Clone() { return this; }
	static now() { return new TimePoint(Number(process.hrtime.bigint() - T0)); }
	static op_Sub(a, b) { return new Duration(subL(a.ns, b.ns)); }
	time_since_epoch() { return new Duration(this.ns); }
}

/** A std::chrono duration held in nanoseconds (C# Cpp.Duration); count() gives seconds (the engine counts durations
 *  as std::chrono::duration<double>). Used only for timing. A C# struct, so an immutable value. */
export class Duration {
	ns;
	constructor(ns = 0) { this.ns = ns; }
	static ZERO = new Duration(0);
	static new_l(n) { return new Duration(n); }
	static new_Duration(d) { return new Duration(d.ns); }
	Clone() { return this; }
	count() { return Number(this.ns) * 1e-9; }
	static op_Add(a, b) { return new Duration(addL(a.ns, b.ns)); }
	static op_Sub(a, b) { return new Duration(subL(a.ns, b.ns)); }
}

// ------------------------------------------------------------------------------------------------ the system

/** std::thread::hardware_concurrency (C# Cpp.Sys): libstdc++ on Linux asks glibc's get_nprocs, the processors
 *  online (/sys/devices/system/cpu/online), not the cgroup or affinity limit. The engine prints it in THREADS
 *  warnings. */
export class Sys {
	static n = -1;
	/** unsigned int: the number of processors online (glibc's get_nprocs). */
	static hardware_concurrency() {
		if (Sys.n >= 0) return Sys.n;
		let n = 0;
		try {
			const s = fs.readFileSync('/sys/devices/system/cpu/online', 'latin1').trim();
			for (const part of s.split(',')) {
				if (part.length === 0) continue;
				const dash = part.indexOf('-');
				if (dash < 0) n++;
				else n += parseInt(part.slice(dash + 1), 10) - parseInt(part.slice(0, dash), 10) + 1;
			}
		} catch (e) { n = 0; }
		if (!(n > 0)) {                                        // glibc's fallback: the cpuN lines of /proc/stat
			n = 0;
			try {
				for (const line of fs.readFileSync('/proc/stat', 'latin1').split('\n'))
					if (line.startsWith('cpu') && line.length > 3 && line.charCodeAt(3) >= 48 && line.charCodeAt(3) <= 57) n++;
			} catch (e) { n = 0; }
		}
		if (!(n > 0)) n = os.cpus().length;
		Sys.n = n >>> 0;
		return Sys.n;
	}
}

/** A unique number per object for this run (C# Cpp.Ident): orders pointers the way only their identity matters (a
 *  std::map key holding table pointers is looked up, never iterated in address order). Weak, as C#'s
 *  ConditionalWeakTable is. */
export class Ident {
	static ids = new WeakMap();
	static next = 0;
	static Of(o) {
		if (o === null || o === undefined) return 0;
		let v = Ident.ids.get(o);
		if (v === undefined) { v = ++Ident.next; Ident.ids.set(o, v); }
		return v;
	}
}

/** std::tuple of more than three elements (C# Cpp.TupN): a map key compared element by element, as std::tuple's
 *  operator< does. Elements: numbers (int, double, enum values), longs, bools, part A's Ptr (compared by the identity
 *  of its array, then its offset) or anything with CompareTo. */
export class TupN {
	v;
	constructor() { this.v = []; }
	/** TupN(params object[] items): the items (one argument that is an array is the items array itself, as a C#
	 *  call with an explicit object[] passes it). */
	static new_oA(...items) {
		const t = new TupN();
		t.v = items.length === 1 && Array.isArray(items[0]) ? items[0] : items;
		return t;
	}
	Clone() { const t = new TupN(); t.v = this.v.slice(); return t; }
	Assign(o) { this.v = o.v.slice(); }
	MoveFrom(o) { this.v = o.v; }
	CompareTo(o) {
		for (let i = 0; i < this.v.length; i++) { const c = tupCmp(this.v[i], o.v[i]); if (c !== 0) return c; }
		return 0;
	}
	Equals(o) { return o instanceof TupN && this.CompareTo(o) === 0; }
	Equals_TupN(o) { return o !== null && o !== undefined && this.CompareTo(o) === 0; }
	Equals_o(o) { return this.Equals(o); }
	GetHashCode() { return this.v.length; }
}
function tupCmp(a, b) {
	if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
	const ta = typeof a;
	if (ta === 'number' || ta === 'bigint') return a < b ? -1 : b < a ? 1 : 0;
	if (ta === 'boolean') return a === b ? 0 : a ? 1 : -1;
	if (a instanceof cpp.Ptr) {
		const p = a, q = b;
		const x = Ident.Of(p.a), y = Ident.Of(q.a);
		if (x !== y) return x < y ? -1 : 1;
		return p.o < q.o ? -1 : q.o < p.o ? 1 : 0;
	}
	if (typeof a.CompareTo === 'function') return a.CompareTo(b);
	throw new SysException('NotSupportedException', 'tuple element ' + a);
}

/** Debugging aid (C# Cpp.Dbg): with the environment variable SWMM6_CS_TRACE set, each exception a translated catch
 *  handler catches is printed to stderr (the engine itself turns most of them into error codes). */
export class Dbg {
	static on = process.env.SWMM6_CS_TRACE !== undefined;
	static Caught(e) {
		if (!Dbg.on) return;
		let s;
		try { s = e instanceof Error && e.stack ? e.stack : String(e); } catch (x) { s = '?'; }
		try { R.stderr_.S.Flush(); } catch (x) { }
		fs.writeSync(2, '[caught] ' + s + '\n');
	}
}

/** std::variant<bool, int, double, std::string> (C# Cpp.Variant, cs/runtime/Std.cs; the engine's user-flag value):
 *  the alternative held and its index in the declared list. Holds<T> and Get<T> (std::holds_alternative, std::get)
 *  depend on a type argument TypeScript does not see and the engine does not call them: Get returns the value held. */
export class Variant {
	v = false;
	idx = 0;
	static new_b(x) { const r = new Variant(); r.Set_b(x); return r; }
	static new_i(x) { const r = new Variant(); r.Set_i(x); return r; }
	static new_d(x) { const r = new Variant(); r.Set_d(x); return r; }
	static new_Str(x) { const r = new Variant(); r.Set_Str(x); return r; }
	Set_b(x) { this.v = x; this.idx = 0; }
	Set_i(x) { this.v = x; this.idx = 1; }
	Set_d(x) { this.v = x; this.idx = 2; }
	Set_Str(x) { this.v = x.Clone(); this.idx = 3; }
	index() { return this.idx; }
	Get() { return this.v; }
	Clone() { const c = new Variant(); c.Assign(this); return c; }
	Assign(o) { this.idx = o.idx; this.v = o.v instanceof cpp.Str ? o.v.Clone() : o.v; }
	MoveFrom(o) { this.idx = o.idx; this.v = o.v; }
}
// (ts/src/cpp/Misc.ts without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)
