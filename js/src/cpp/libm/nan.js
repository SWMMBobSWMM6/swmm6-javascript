// nan.js - glibc's NaN results for the libm functions the runtime computes itself (SysMath.ts, Misc.ts's LibM).
// An internal module of the runtime (not re-exported by index.ts).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

const F = new Float64Array(1);
const W = new Uint32Array(F.buffer);       // little-endian: W[0] low word, W[1] high word

/** x86's default NaN (0/0, inf - inf): quiet, sign bit set. */
export const DEFAULT_NAN = (() => { W[1] = 0xfff80000; W[0] = 0; return F[0]; })();

/** A NaN operand as the hardware passes it on: quieted, sign and payload kept. */
export function quietNaN(x) { F[0] = x; W[1] = (W[1] | 0x80000) >>> 0; return F[0]; }
/** The NaN result of a two-operand operation with at least one NaN operand: a's if it is one, else b's. */
export function pickNaN(a, b) { return a !== a ? quietNaN(a) : quietNaN(b); }
/** A one-argument function's result r for x with glibc's NaNs: a NaN argument comes back quieted, a domain error
 *  gives the default NaN. */
export function libmNaN1(x, r) {
	if (x !== x) return quietNaN(x);
	return r !== r ? DEFAULT_NAN : r;
}
// (ts/src/cpp/libm/nan.ts without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)
