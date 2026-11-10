// a_long.ts - part A of the TypeScript runtime (package cpp): exact 64-bit and 32-bit integer arithmetic (cpp.L) and
// x86-64 double-to-integer conversion (cpp.Conv, cs/runtime/Misc.cs Conv and the C# R.D2I family).
//
// A C# long or ulong is a cpp.L: a number while it is a safe integer (|v| <= 2^53 - 1), a bigint otherwise, never -0
// (ts/RUNTIME_HELPERS.md, "Values"). Every helper takes canonical values and returns a canonical value. The fast path
// computes in number when both operands are numbers and the exact result is safe (a number result of +, -, * whose
// magnitude is at most 2^53 - 1 is exact: a true result beyond 2^53 rounds to at least 2^53); otherwise the helper
// computes in BigInt and wraps with BigInt.asIntN(64, r) / BigInt.asUintN(64, r). Division by zero and the
// (-2^63) / -1 overflow throw cpp.SysException (a .NET exception, which only catch-all clauses take).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

import * as cpp from './index.js';

/** A C# long or ulong: a number when |v| <= 2^53 - 1, otherwise a bigint (long in [-2^63, 2^63), ulong in [0, 2^64)). */
export type L = number | bigint;

const MAX = 9007199254740991;          // 2^53 - 1
const MAXn = 9007199254740991n;
const MIN64 = -9223372036854775808n;
const P2: number[] = [];               // 2^k, exact
for (let k = 0, p = 1; k < 64; k++, p *= 2) P2.push(p);

/** A bigint long result in canonical form. */
function nL(r: bigint): L { return (r >= -MAXn && r <= MAXn) ? Number(r) : r; }
/** A bigint ulong result (r >= 0) in canonical form. */
function nUL(r: bigint): L { return r <= MAXn ? Number(r) : r; }

function divZero(): never { throw new (cpp as any).SysException("DivideByZeroException", "Attempted to divide by zero."); }
function overflow(): never { throw new (cpp as any).SysException("OverflowException", "Arithmetic operation resulted in an overflow."); }

// ---------------------------------------------------------------- long (signed 64-bit)
function addL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= MAX && r >= -MAX) return r; }
	return nL(BigInt.asIntN(64, BigInt(a) + BigInt(b)));
}
function subL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r <= MAX && r >= -MAX) return r; }
	return nL(BigInt.asIntN(64, BigInt(a) - BigInt(b)));
}
function mulL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= MAX && r >= -MAX) return r + 0; }
	return nL(BigInt.asIntN(64, BigInt(a) * BigInt(b)));
}
/** long a / b, truncating toward zero; b == 0 and (-2^63) / -1 throw. */
function divL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') {
		if (b === 0) divZero();
		const r = a % b;                     // exact (fmod), the dividend's sign
		return (a - r) / b + 0;              // an exact multiple of b divided by b: exact
	}
	const x = BigInt(a), y = BigInt(b);
	if (y === 0n) divZero();
	if (y === -1n && x === MIN64) overflow();
	return nL(x / y);
}
/** long a % b: the dividend's sign; b == 0 and (-2^63) % -1 throw (as x64 .NET does). */
function remL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') {
		if (b === 0) divZero();
		return a % b + 0;
	}
	const x = BigInt(a), y = BigInt(b);
	if (y === 0n) divZero();
	if (y === -1n && x === MIN64) overflow();
	return nL(x % y);
}
function andL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number' && (a | 0) === a && (b | 0) === b) return a & b;
	return nL(BigInt.asIntN(64, BigInt(a) & BigInt(b)));
}
function orL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number' && (a | 0) === a && (b | 0) === b) return a | b;
	return nL(BigInt.asIntN(64, BigInt(a) | BigInt(b)));
}
function xorL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number' && (a | 0) === a && (b | 0) === b) return a ^ b;
	return nL(BigInt.asIntN(64, BigInt(a) ^ BigInt(b)));
}
/** a << (n & 63), wrapped to signed 64 bits. */
function shlL(a: L, n: number): L {
	n &= 63;
	if (typeof a === 'number') { const r = a * P2[n]; if (r <= MAX && r >= -MAX) return r; }
	return nL(BigInt.asIntN(64, BigInt(a) << BigInt(n)));
}
/** a >> (n & 63), arithmetic. */
function shrL(a: L, n: number): L {
	n &= 63;
	if (typeof a === 'number') return Math.floor(a / P2[n]);
	return nL(a >> BigInt(n));
}
/** C# 11 a >>> (n & 63) on a long: the 64-bit pattern shifted logically, the result a long. */
function ushrL(a: L, n: number): L {
	n &= 63;
	if (n === 0) return a;
	if (a >= 0) return shrL(a, n);
	return nL(BigInt.asUintN(64, BigInt(a)) >> BigInt(n));
}
function negL(a: L): L {
	if (typeof a === 'number') return 0 - a;
	return nL(BigInt.asIntN(64, -a));
}
function notL(a: L): L {
	if (typeof a === 'number') { const r = -a - 1; return r >= -MAX ? r : BigInt(r); }
	return nL(~a);
}
function incL(a: L): L { return (typeof a === 'number' && a < MAX) ? a + 1 : addL(a, 1); }
function decL(a: L): L { return (typeof a === 'number' && a > -MAX) ? a - 1 : subL(a, 1); }

// ---------------------------------------------------------------- ulong (unsigned 64-bit)
function addUL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= MAX) return r; }
	return nUL(BigInt.asUintN(64, BigInt(a) + BigInt(b)));
}
function subUL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r >= 0) return r; }
	return nUL(BigInt.asUintN(64, BigInt(a) - BigInt(b)));
}
function mulUL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= MAX) return r; }
	return nUL(BigInt.asUintN(64, BigInt(a) * BigInt(b)));
}
function divUL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') {
		if (b === 0) divZero();
		const r = a % b;
		return (a - r) / b;
	}
	const y = BigInt(b);
	if (y === 0n) divZero();
	return nUL(BigInt(a) / y);
}
function remUL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') {
		if (b === 0) divZero();
		return a % b;
	}
	const y = BigInt(b);
	if (y === 0n) divZero();
	return nUL(BigInt(a) % y);
}
function andUL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number' && (a >>> 0) === a && (b >>> 0) === b) return (a & b) >>> 0;
	return nUL(BigInt(a) & BigInt(b));
}
function orUL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number' && (a >>> 0) === a && (b >>> 0) === b) return (a | b) >>> 0;
	return nUL(BigInt(a) | BigInt(b));
}
function xorUL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number' && (a >>> 0) === a && (b >>> 0) === b) return (a ^ b) >>> 0;
	return nUL(BigInt(a) ^ BigInt(b));
}
function shlUL(a: L, n: number): L {
	n &= 63;
	if (typeof a === 'number') { const r = a * P2[n]; if (r <= MAX) return r; }
	return nUL(BigInt.asUintN(64, BigInt(a) << BigInt(n)));
}
/** a >> (n & 63), logical (a is unsigned). */
function shrUL(a: L, n: number): L {
	n &= 63;
	if (typeof a === 'number') return Math.floor(a / P2[n]);
	return nUL(a >> BigInt(n));
}
function negUL(a: L): L { return subUL(0, a); }
function notUL(a: L): L { return nUL(BigInt.asUintN(64, ~BigInt(a))); }
function incUL(a: L): L { return (typeof a === 'number' && a < MAX) ? a + 1 : addUL(a, 1); }
function decUL(a: L): L { return (typeof a === 'number' && a > 0) ? a - 1 : subUL(a, 1); }

// ---------------------------------------------------------------- int and uint (32-bit) division
/** int a / b, truncating; b == 0 throws; (-2^31) / -1 throws (OverflowException). */
function divI(a: number, b: number): number {
	if (b === 0) divZero();
	if (b === -1 && a === -2147483648) overflow();
	return (a / b) | 0;                      // |a|, |b| < 2^31: the rounded quotient truncates to the exact one
}
function remI(a: number, b: number): number {
	if (b === 0) divZero();
	if (b === -1 && a === -2147483648) overflow();
	return (a % b) | 0;
}
/** uint a / b (operands in [0, 2^32)); b == 0 throws. */
function divU(a: number, b: number): number {
	if (b === 0) divZero();
	return (a / b) >>> 0;
}
function remU(a: number, b: number): number {
	if (b === 0) divZero();
	return a % b;
}

// ---------------------------------------------------------------- conversions
/** The low 32 bits of a long or ulong as an int. */
function toI32(x: L): number { return typeof x === 'number' ? x | 0 : Number(BigInt.asIntN(32, x)); }
/** The low 32 bits as a uint. */
function toU32(x: L): number { return typeof x === 'number' ? x >>> 0 : Number(BigInt.asUintN(32, x)); }
/** The low 16 bits as a short / ushort, the low 8 as an sbyte / byte. */
function toI16(x: L): number { return (toI32(x) << 16) >> 16; }
function toU16(x: L): number { return toI32(x) & 0xFFFF; }
function toI8(x: L): number { return (toI32(x) << 24) >> 24; }
function toU8(x: L): number { return toI32(x) & 0xFF; }
/** ulong to long: the same 64 bits (x >= 2^63 becomes x - 2^64). */
function toI64(x: L): L { return typeof x === 'number' ? x : nL(BigInt.asIntN(64, x)); }
/** long (or int) to ulong: the same 64 bits (x < 0 becomes x + 2^64). */
function toU64(x: L): L {
	if (typeof x === 'number') return x >= 0 ? x : nUL(BigInt.asUintN(64, BigInt(x)));
	return nUL(BigInt.asUintN(64, x));
}
/** long or ulong to double: the nearest, ties to even. */
function toF64(x: L): number { return typeof x === 'number' ? x : Number(x); }
/** long or ulong to float, rounded once to the nearest float32 (ties to even), as cvtsi2ss does. */
function toF32(x: L): number {
	if (typeof x === 'number') return Math.fround(x);
	const neg = x < 0n;
	let m = neg ? -x : x;
	const bits = m.toString(2).length;
	if (bits > 24) {
		const sh = BigInt(bits - 24);
		let q = m >> sh;
		const rem = m - (q << sh), half = 1n << (sh - 1n);
		if (rem > half || (rem === half && (q & 1n) === 1n)) q += 1n;
		m = q << sh;
	}
	const r = Number(m);                     // at most 24 significant bits: exact
	return Math.fround(neg ? -r : r);
}
/** A long or ulong array index as a number. */
function ix(x: L): number { return typeof x === 'number' ? x : Number(x); }

/** The integer helpers the engine calls as cpp.L.<name> (ts/RUNTIME_HELPERS.md, "cpp.L"). */
export const L = {
	addL, subL, mulL, divL, remL, andL, orL, xorL, shlL, shrL, ushrL, negL, notL, incL, decL,
	addUL, subUL, mulUL, divUL, remUL, andUL, orUL, xorUL, shlUL, shrUL, negUL, notUL, incUL, decUL,
	divI, remI, divU, remU,
	toI32, toU32, toI16, toU16, toI8, toU8, toI64, toU64, toF64, toF32, ix,
};

// ---------------------------------------------------------------- double to integer (x86-64 cvttsd2si)
/** C# Cpp.Conv: NaN and out-of-range give the "integer indefinite" value (-2^31, -2^63); GCC's unsigned rules. */
export class Conv {
	static D2I(x: number): number { return (x > -2147483649.0 && x < 2147483648.0) ? x | 0 : -2147483648; }
	static D2L(x: number): L {
		if (!(x >= -9223372036854775808.0 && x < 9223372036854775808.0)) return MIN64;
		const t = Math.trunc(x);
		return (t <= MAX && t >= -MAX) ? t + 0 : BigInt(t);
	}
	/** GCC's double -> unsigned int: the 64-bit conversion, truncated. */
	static D2U(x: number): number { return toU32(Conv.D2L(x)); }
	/** GCC's double -> unsigned long: below 2^63 the signed conversion, above it the conversion of x - 2^63. */
	static D2UL(x: number): L {
		if (x < 9223372036854775808.0) return toU64(Conv.D2L(x));
		return nUL(BigInt.asUintN(64, BigInt(Conv.D2L(x - 9223372036854775808.0))) ^ 0x8000000000000000n);
	}
	static D2S(x: number): number { return (Conv.D2I(x) << 16) >> 16; }
	static D2US(x: number): number { return Conv.D2I(x) & 0xFFFF; }
	static D2SB(x: number): number { return (Conv.D2I(x) << 24) >> 24; }
	static D2B(x: number): number { return Conv.D2I(x) & 0xFF; }
}
