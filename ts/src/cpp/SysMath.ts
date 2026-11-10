// SysMath.ts - runtime part C: C#'s System.Math as the C# engine runs it on Linux x64 (cpp.SysMath.<Name>_<codes>, as the manifest
// ts/cs2ts_runtime.txt names it). .NET computes Abs, Floor, Ceiling, Truncate, CopySign and Sqrt itself, exactly, and
// calls glibc's libm for the transcendental functions.
// exp, log, log10, pow, sin, cos, tan, asin, acos and atan come from libm/glibm.ts (bit-exact translations of glibc
// 2.39's x86-64 FMA variants, copied from the SWMM5 TypeScript port); atan2, cbrt, cosh, sinh, tanh and log2 from
// libm/glibm2.ts (the same translation of glibc 2.39: atan2, sinh, tanh and log2 from the FMA variants, cbrt and cosh
// generic, as x86-64 glibc runs them; the FV solver's friction term calls cbrt, lessons/30). Every one is glibc's bit
// for bit, its NaNs too (tests/crtcheck/tscheck compares them with the system libm).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.
import * as G from './libm/glibm.js';
import * as G2 from './libm/glibm2.js';

import { quietNaN } from './libm/nan.js';

const F = new Float64Array(1);
const W = new Uint32Array(F.buffer);       // little-endian: W[0] low word, W[1] high word
function signBit(x: number): boolean { F[0] = x; return (W[1] >>> 31) === 1; }

export class SysMath {
	static Abs_d(x: number): number { return Math.abs(x); }
	static Acos_d(x: number): number { return G.acos(x); }
	static Asin_d(x: number): number { return G.asin(x); }
	static Atan_d(x: number): number { return G.atan(x); }
	/** Math.Atan2(y, x). */
	static Atan2_d_d(y: number, x: number): number { return G2.atan2(y, x); }
	static Cbrt_d(x: number): number { return G2.cbrt(x); }
	static Ceiling_d(x: number): number { return Math.ceil(x); }
	/** Math.CopySign: x's magnitude with y's sign bit (a NaN y's sign too). */
	static CopySign_d_d(x: number, y: number): number {
		const neg = signBit(y);
		F[0] = x;
		W[1] = neg ? (W[1] | 0x80000000) >>> 0 : W[1] & 0x7fffffff;
		return F[0];
	}
	static Cos_d(x: number): number { return G.cos(x); }
	static Cosh_d(x: number): number { return G2.cosh(x); }
	static Exp_d(x: number): number { return G.exp(x); }
	static Floor_d(x: number): number { return Math.floor(x); }
	static Log_d(x: number): number { return G.log(x); }
	static Log10_d(x: number): number { return G.log10(x); }
	static Log2_d(x: number): number { return G2.log2(x); }
	/** Math.Pow. glibc's pow returns x + y when both are NaN, which x86 makes x's NaN (quieted); V8 may evaluate
	 *  x + y with the operands swapped, so that case is decided here. */
	static Pow_d_d(x: number, y: number): number {
		if (x !== x && y !== y) return quietNaN(x);
		return G.pow(x, y);
	}
	static Sin_d(x: number): number { return G.sin(x); }
	static Sinh_d(x: number): number { return G2.sinh(x); }
	static Sqrt_d(x: number): number { return Math.sqrt(x); }
	static Tan_d(x: number): number { return G.tan(x); }
	static Tanh_d(x: number): number { return G2.tanh(x); }
	/** Math.Truncate: toward zero, the sign of zero kept. */
	static Truncate_d(x: number): number { return Math.trunc(x); }
}
