// a_str.ts - part A of the TypeScript runtime (package cpp): C's char* (CPtr, the struct at the top of
// cs/runtime/CRuntime.cs) and std::string (Str, cs/runtime/Str.cs), byte for byte as the C# runtime has them.
//
// Bytes: CPtr.B is the buffer and CPtr.O the offset. B is a Uint8Array (a Str's buffer, a literal) or a number[]
// (a std::vector<unsigned char>'s storage, Vec<byte>.a, adopted by from_Ptruc; or an sbyte array adopted by
// from_Ptrc, whose elements are -128..127). So read B[k] & 0xFF for the unsigned byte and (B[k] << 24) >> 24 for the
// signed char, and write the low byte (v & 0xFF). The engine reads a CPtr's elements with p.get(i) (the signed char,
// as x86 C's char), writes them with p.set(i, v) (the low byte of the int v) and refers to one with p.ref(i).
// Str.b is always a Uint8Array whose length is the capacity (at least n + 1, b[n] == 0 whenever c_str() is taken);
// Str.n is the length. Both are read and written directly by the engine and the other parts of the runtime.
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

import * as cpp from './index.js';
import type { L } from './a_long.js';
import { Cell, ArrRef, type Ref } from './a_ref.js';
import { Ptr, Iter, OutOfRange, InvalidArgument } from './a_std.js';

/** A byte buffer as a CPtr holds one. */
export type ByteBuf = Uint8Array | number[];

const NPOS = 18446744073709551615n;

/** (int)n of a long or ulong n (an offset). */
function i32(n: L): number { return typeof n === 'number' ? n | 0 : Number(BigInt.asIntN(32, n)); }
/** min(a, k) for a ulong a and a small non-negative k, as a number. */
function umin(a: L, k: number): number { return typeof a === 'number' ? (a < k ? a : k) : k; }
/** A ulong start position as a number (a bigint is past every string's end). */
function upos(a: L): number { return typeof a === 'number' ? a : Infinity; }

/** strlen: the bytes before the first NUL. */
function strlen(p: CPtr): number {
	const b = p.B;
	let i = p.O;
	while (b[i] !== 0) i++;
	return i - p.O;
}

/** Copy len bytes of src from off into dst at d (src a Uint8Array or a number[] of bytes or sbytes). */
function copyIn(dst: Uint8Array, d: number, src: ByteBuf, off: number, len: number): void {
	if (len <= 0) return;
	if (src === dst) { dst.copyWithin(d, off, off + len); return; }       // memmove, as Array.Copy within one array
	if (len > 32 && src instanceof Uint8Array) { dst.set(src.subarray(off, off + len), d); return; }
	for (let i = 0; i < len; i++) dst[d + i] = src[off + i];
}

/** Latin-1 text of n bytes from off (each byte one character, 0..255). */
function latin1(b: ByteBuf, off: number, n: number): string {
	let s = '';
	for (let i = 0; i < n; i += 8192) {
		const k = Math.min(n - i, 8192), part: number[] = new Array(k);
		for (let j = 0; j < k; j++) part[j] = b[off + i + j] & 0xFF;
		s += String.fromCharCode.apply(null, part);
	}
	return s;
}

/** Encoding.Latin1.GetBytes: one byte per character, '?' for a character above U+00FF (a surrogate pair is one). */
function latin1Bytes(s: string): number[] {
	const r: number[] = [];
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c <= 0xFF) r.push(c);
		else {
			r.push(63);
			if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { const d = s.charCodeAt(i + 1); if (d >= 0xDC00 && d <= 0xDFFF) i++; }
		}
	}
	return r;
}

let nextId = 1;
const ids = new WeakMap<object, number>();
function idHash(o: object | null): number {
	if (o == null) return 0;
	let v = ids.get(o);
	if (v === undefined) { v = nextId++; ids.set(o, v); }
	return v;
}

/** One element of a char buffer as a reference: reads sign-extend the byte, writes keep the low 8 bits. */
class CPtrRef implements Ref<number> {
	readonly B: ByteBuf;
	readonly k: number;
	constructor(b: ByteBuf, k: number) { this.B = b; this.k = k; }
	get(): number { return (this.B[this.k] << 24) >> 24; }
	set(v: number): void { this.B[this.k] = v & 0xFF; }
}

/** C char*: a byte buffer and an offset; null has a null buffer. An immutable value (arithmetic makes a new one). */
export class CPtr {
	readonly B: ByteBuf;
	readonly O: number;
	constructor(b: ByteBuf, o: number) { this.B = b; this.O = o; }

	/** default(CPtr): the null pointer. */
	static readonly ZERO: CPtr = new CPtr(null, 0);
	static readonly Null: CPtr = CPtr.ZERO;

	Clone(): CPtr { return this; }
	get_IsNull(): boolean { return this.B == null; }

	/** p[i]: the signed char (-128..127). */
	get(i: number): number { return (this.B[this.O + i] << 24) >> 24; }
	/** p[i] = v: the low byte of v. */
	set(i: number, v: number): void { this.B[this.O + i] = v & 0xFF; }
	/** A reference to p[i] (reads give the signed char, writes the low byte). */
	ref(i: number): Ref<number> { return new CPtrRef(this.B, this.O + i); }
	/** The C# indexer under its property names. */
	get_Item(i: number): number { return (this.B[this.O + i] << 24) >> 24; }
	set_Item(i: number, v: number): void { this.B[this.O + i] = v & 0xFF; }
	ref_Item(i: number): Ref<number> { return new CPtrRef(this.B, this.O + i); }

	/** A char* made from a std::vector<char> or std::array<char, N> (sbyte storage): the same array. */
	static from_Ptrc(p: Ptr<number>): CPtr { return new CPtr(p.a as any, p.o); }
	/** A char* made from unsigned char storage: the same array. */
	static from_Ptruc(p: Ptr<number>): CPtr { return new CPtr(p.a as any, p.o); }

	static op_Add_CPtr_i(p: CPtr, n: number): CPtr { return new CPtr(p.B, p.O + n); }
	static op_Add_CPtr_l(p: CPtr, n: L): CPtr { return new CPtr(p.B, p.O + i32(n)); }
	static op_Add_CPtr_ul(p: CPtr, n: L): CPtr { return new CPtr(p.B, p.O + i32(n)); }
	static op_Sub(p: CPtr, n: number): CPtr { return new CPtr(p.B, p.O - n); }
	static op_Increment(p: CPtr): CPtr { return new CPtr(p.B, p.O + 1); }
	static op_Decrement(p: CPtr): CPtr { return new CPtr(p.B, p.O - 1); }
	static op_Eq(a: CPtr, b: CPtr): boolean { return a.B == null ? b.B == null : (a.B === b.B && a.O === b.O); }
	static op_Ne(a: CPtr, b: CPtr): boolean { return !CPtr.op_Eq(a, b); }
	static op_Lt(a: CPtr, b: CPtr): boolean { return a.O < b.O; }
	static op_Gt(a: CPtr, b: CPtr): boolean { return a.O > b.O; }
	static op_Le(a: CPtr, b: CPtr): boolean { return a.O <= b.O; }
	static op_Ge(a: CPtr, b: CPtr): boolean { return a.O >= b.O; }
	/** a - b (a long). */
	static Diff(a: CPtr, b: CPtr): L { return a.O - b.O; }
	Equals_CPtr(o: CPtr): boolean { return CPtr.op_Eq(this, o); }
	Equals_o(o: any): boolean { return o instanceof CPtr && CPtr.op_Eq(this, o); }
	GetHashCode(): number { return (idHash(this.B as any) ^ this.O) | 0; }
	/** The NUL-terminated bytes as Latin-1 text (or up to the buffer's end), "(null)" for the null pointer. */
	toString(): string {
		const b = this.B;
		if (b == null) return "(null)";
		let e = this.O;
		while (e < b.length && b[e] !== 0) e++;
		return latin1(b, this.O, e - this.O);
	}
}

// ---------------------------------------------------------------- printf("%f") for std::to_string(double)
const dv = new DataView(new ArrayBuffer(8));
/** glibc's %f of a double: the exact binary value rounded to 6 decimals, ties to even; "inf", "nan" with the sign. */
function fmtF6(v: number): string {
	dv.setFloat64(0, v);
	const hi = dv.getUint32(0), lo = dv.getUint32(4);
	const neg = (hi >>> 31) !== 0, e = (hi >>> 20) & 0x7FF;
	const frac = BigInt(hi & 0xFFFFF) * 4294967296n + BigInt(lo);
	if (e === 0x7FF) return (neg ? "-" : "") + (frac === 0n ? "inf" : "nan");
	const m = e === 0 ? frac : frac + 4503599627370496n;
	const ex = e === 0 ? -1074 : e - 1075;
	let N: bigint;
	if (ex >= 0) N = (m << BigInt(ex)) * 1000000n;
	else {
		const num = m * 1000000n, sh = BigInt(-ex);
		N = num >> sh;
		const rem = num - (N << sh), half = 1n << (sh - 1n);
		if (rem > half || (rem === half && (N & 1n) === 1n)) N += 1n;
	}
	const s = N.toString().padStart(7, '0');
	return (neg ? "-" : "") + s.slice(0, s.length - 6) + "." + s.slice(s.length - 6);
}

function isSpace(c: number): boolean { return c === 32 || (c >= 9 && c <= 13); }

/** R.strtol as the C# runtime has it (base 10 only; saturates at the long range). */
function strtol10(s: CPtr, end: Ref<CPtr>): L {
	const b = s.B;
	let i = s.O;
	while (isSpace(b[i] & 0xFF)) i++;
	let neg = false;
	if (b[i] === 43 || b[i] === 45) { neg = b[i] === 45; i++; }
	const st = i;
	let v = 0n;
	while ((b[i] & 0xFF) >= 48 && (b[i] & 0xFF) <= 57) { v = v * 10n + BigInt((b[i] & 0xFF) - 48); i++; }
	if (i === st) { end.set(s); return 0; }
	end.set(new CPtr(b, i));
	if (neg) v = -v;
	if (v > 9223372036854775807n) v = 9223372036854775807n;
	if (v < -9223372036854775808n) v = -9223372036854775808n;
	return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : v;
}

/** std::string (and std::string_view) as a mutable byte sequence; npos is the ulong 2^64 - 1. */
export class Str {
	/** The bytes (capacity b.length >= n + 1). */
	b: Uint8Array;
	/** The length. */
	n: number;
	/** new Str(): the empty string (C#'s Str()). The arguments are internal: adopt the buffer b holding n bytes. */
	constructor(b?: Uint8Array, n?: number) { this.b = b === undefined ? new Uint8Array(16) : b; this.n = n === undefined ? 0 : n; }

	static readonly npos: L = NPOS;

	/** A new string of len bytes of src from off (C#'s Str(byte[], int, int)). */
	static new_ucA_i_i(src: ByteBuf, off: number, len: number): Str {
		const b = new Uint8Array(len + 1);
		copyIn(b, 0, src, off, len);
		return new Str(b, len);
	}
	/** The copy constructor. */
	static new_Str(s: Str): Str { return Str.new_ucA_i_i(s.b, 0, s.n); }
	/** From C# text: Latin-1 bytes. */
	static new_str(s: string): Str { const e = latin1Bytes(s); return Str.new_ucA_i_i(e, 0, e.length); }
	static new_CPtr(p: CPtr): Str { return Str.new_ucA_i_i(p.B, p.O, strlen(p)); }
	static new_CPtr_ul(p: CPtr, len: L): Str { return Str.new_ucA_i_i(p.B, p.O, Number(len)); }
	static new_ul_i(count: L, ch: number): Str {
		const n = Number(count), b = new Uint8Array(n + 1);
		b.fill(ch & 0xFF, 0, n);
		return new Str(b, n);
	}
	static new_Str_ul_ul(s: Str, pos: L, len: L = NPOS): Str {
		const p = Number(pos), m = umin(len, s.n - p);
		return Str.new_ucA_i_i(s.b, p, m);
	}
	static FromBytes(x: ByteBuf): Str { return Str.new_ucA_i_i(x, 0, x.length); }
	/** const char* -> std::string (C++'s implicit conversion). */
	static from_CPtr(p: CPtr): Str { return Str.new_CPtr(p); }

	/** C#'s Reserve: room for need bytes and the NUL (at least doubling). */
	private grow_(need: number): void {
		const len = this.b.length;
		if (need + 1 <= len) return;
		const nb = new Uint8Array(Math.max(need + 1, len * 2));
		nb.set(this.b);
		this.b = nb;
	}

	// ---- size, access
	size(): L { return this.n; }
	length(): L { return this.n; }
	empty(): boolean { return this.n === 0; }
	clear(): void { this.n = 0; }
	c_str(): CPtr { this.grow_(this.n); this.b[this.n] = 0; return new CPtr(this.b, 0); }
	data(): CPtr { return this.c_str(); }
	get_Item_ul(i: L): number { return this.b[Number(i)]; }
	get_Item_l(i: L): number { return this.b[Number(i)]; }
	get_Item_i(i: number): number { return this.b[i]; }
	ref_Item_ul(i: L): Ref<number> { return new ArrRef<number>(this.b, Number(i)); }
	ref_Item_l(i: L): Ref<number> { return new ArrRef<number>(this.b, Number(i)); }
	ref_Item_i(i: number): Ref<number> { return new ArrRef<number>(this.b, i); }
	at(i: L): number {
		if (i >= this.n) throw OutOfRange.new_str("basic_string::at: __n (which is " + i + ") >= this->size() (which is " + this.n + ")");
		return this.b[Number(i)];
	}
	front(): number { return this.b[0]; }
	ref_front(): Ref<number> { return new ArrRef<number>(this.b, 0); }
	back(): number { return this.b[this.n - 1]; }
	ref_back(): Ref<number> { return new ArrRef<number>(this.b, this.n - 1); }
	/** The byte at i as a signed char. */
	Char(i: L): number { return (this.b[Number(i)] << 24) >> 24; }

	// ---- copy, assign, move
	Clone(): Str { return Str.new_ucA_i_i(this.b, 0, this.n); }
	/** ICopy's Assign (the copy assignment from a Str). */
	Assign(o: Str): void { this.Assign_Str(o); }
	Assign_Str(o: Str): void {
		if (this === o) return;
		this.grow_(o.n);
		copyIn(this.b, 0, o.b, 0, o.n);
		this.n = o.n;
	}
	Assign_CPtr(p: CPtr): void {
		const m = strlen(p), t = new Uint8Array(m + 1);
		copyIn(t, 0, p.B, p.O, m);
		this.b = t; this.n = m;
	}
	Assign_i(ch: number): void { this.grow_(1); this.b[0] = ch & 0xFF; this.n = 1; }
	MoveFrom(o: Str): void {
		if (this === o) return;
		this.b = o.b; this.n = o.n;
		o.b = new Uint8Array(16); o.n = 0;
	}
	assign_Str(o: Str): Str { this.Assign_Str(o); return this; }
	assign_CPtr(p: CPtr): Str { this.Assign_CPtr(p); return this; }
	/** assign(first, last). */
	assign_CPtr_CPtr(b0: CPtr, e0: CPtr): Str { return this.assign_CPtr_ul(b0, e0.O - b0.O); }
	assign_Ptrc_Ptrc(b0: Ptr<number>, e0: Ptr<number>): Str { return this.assign_CPtr_ul(CPtr.from_Ptrc(b0), e0.o - b0.o); }
	assign_CPtr_ul(p: CPtr, len: L): Str {
		const m = Number(len), t = new Uint8Array(m + 1);
		copyIn(t, 0, p.B, p.O, m);
		this.b = t; this.n = m;
		return this;
	}
	assign_ul_i(count: L, ch: number): Str {
		const m = Number(count);
		this.grow_(m);
		this.b.fill(ch & 0xFF, 0, m);
		this.n = m;
		return this;
	}

	// ---- append, push, resize
	append_Str(o: Str): Str {
		const m = o.n;
		this.grow_(this.n + m);
		copyIn(this.b, this.n, o.b, 0, m);
		this.n += m;
		return this;
	}
	append_Str_ul_ul(o: Str, pos: L, len: L): Str {
		const p = Number(pos), m = umin(len, o.n - p);
		this.grow_(this.n + m);
		copyIn(this.b, this.n, o.b, p, m);
		this.n += m;
		return this;
	}
	append_CPtr(p: CPtr): Str {
		const m = strlen(p);
		this.grow_(this.n + m);
		copyIn(this.b, this.n, p.B, p.O, m);
		this.n += m;
		return this;
	}
	append_CPtr_ul(p: CPtr, len: L): Str {
		const m = Number(len);
		if (m === 0) return this;           // no bytes, even at a null pointer (the data() of an empty vector)
		this.grow_(this.n + m);
		copyIn(this.b, this.n, p.B, p.O, m);
		this.n += m;
		return this;
	}
	append_ul_i(count: L, ch: number): Str {
		const m = Number(count);
		this.grow_(this.n + m);
		this.b.fill(ch & 0xFF, this.n, this.n + m);
		this.n += m;
		return this;
	}
	append_i(ch: number): Str { return this.append_ul_i(1, ch); }
	push_back(ch: number): void { this.grow_(this.n + 1); this.b[this.n++] = ch & 0xFF; }
	pop_back(): void { this.n--; }
	resize(m: L, ch: number = 0): void {
		const k = Number(m);
		this.grow_(k);
		if (k > this.n) this.b.fill(ch & 0xFF, this.n, k);
		this.n = k;
	}
	reserve(m: L): void { this.grow_(Number(m)); }
	shrink_to_fit(): void { }
	/** string_view::remove_prefix / remove_suffix (a view is a Str of its own). */
	remove_prefix(k: L): void { const m = Number(k); this.b.copyWithin(0, m, this.n); this.n -= m; this.b[this.n] = 0; }
	remove_suffix(k: L): void { this.n -= Number(k); this.b[this.n] = 0; }

	// ---- substrings and edits
	substr(pos: L = 0, len: L = NPOS): Str {
		if (pos > this.n) throw OutOfRange.new_str("basic_string::substr: __pos (which is " + pos + ") > this->size() (which is " + this.n + ")");
		const p = Number(pos);
		return Str.new_ucA_i_i(this.b, p, umin(len, this.n - p));
	}
	erase(pos: L = 0, len: L = NPOS): Str {
		const p = Number(pos), m = umin(len, this.n - p);
		this.b.copyWithin(p, p + m, this.n);
		this.n -= m;
		return this;
	}
	insert_ul_Str(pos: L, s: Str): Str {
		const p = Number(pos), k = s.n;
		this.grow_(this.n + k);
		this.b.copyWithin(p + k, p, this.n);
		copyIn(this.b, p, s.b, 0, k);
		this.n += k;
		return this;
	}
	insert_ul_CPtr(pos: L, s: CPtr): Str { return this.insert_ul_Str(pos, Str.new_CPtr(s)); }
	insert_ul_ul_i(pos: L, count: L, ch: number): Str { return this.insert_ul_Str(pos, Str.new_ul_i(count, ch)); }
	replace_ul_ul_Str(pos: L, len: L, s: Str): Str {
		const n = this.n, p = Number(pos), m = umin(len, n - p);
		const t = new Uint8Array(n - m + s.n + 1);
		copyIn(t, 0, this.b, 0, p);
		copyIn(t, p, s.b, 0, s.n);
		copyIn(t, p + s.n, this.b, p + m, n - p - m);
		this.b = t; this.n = n - m + s.n;
		return this;
	}
	replace_ul_ul_CPtr(pos: L, len: L, s: CPtr): Str { return this.replace_ul_ul_Str(pos, len, Str.new_CPtr(s)); }

	// ---- searching (positions are ulongs; npos when not found)
	private static In(c: number, set: Str): boolean { const b = set.b; for (let i = 0; i < set.n; i++) if (b[i] === c) return true; return false; }

	find_Str_ul(s: Str, pos: L = 0): L {
		const n = this.n, k = s.n, b = this.b, t = s.b;
		if (k === 0) return pos <= n ? pos : NPOS;
		for (let i = upos(pos); i + k <= n; i++) {
			let j = 0;
			while (j < k && b[i + j] === t[j]) j++;
			if (j === k) return i;
		}
		return NPOS;
	}
	find_CPtr_ul(s: CPtr, pos: L = 0): L { return this.find_Str_ul(Str.new_CPtr(s), pos); }
	find_i_ul(ch: number, pos: L = 0): L {
		const c = ch & 0xFF, b = this.b, n = this.n;
		for (let i = upos(pos); i < n; i++) if (b[i] === c) return i;
		return NPOS;
	}
	rfind_Str_ul(s: Str, pos: L = NPOS): L {
		const n = this.n, k = s.n, b = this.b, t = s.b;
		if (k > n) return NPOS;
		for (let i = umin(pos, n - k); i >= 0; i--) {
			let j = 0;
			while (j < k && b[i + j] === t[j]) j++;
			if (j === k) return i;
		}
		return NPOS;
	}
	rfind_CPtr_ul(s: CPtr, pos: L = NPOS): L { return this.rfind_Str_ul(Str.new_CPtr(s), pos); }
	rfind_i_ul(ch: number, pos: L = NPOS): L {
		const n = this.n;
		if (n === 0) return NPOS;
		const c = ch & 0xFF, b = this.b;
		for (let i = umin(pos, n - 1); i >= 0; i--) if (b[i] === c) return i;
		return NPOS;
	}
	find_first_of_Str_ul(set: Str, pos: L = 0): L {
		const b = this.b, n = this.n;
		for (let i = upos(pos); i < n; i++) if (Str.In(b[i], set)) return i;
		return NPOS;
	}
	find_first_of_CPtr_ul(set: CPtr, pos: L = 0): L { return this.find_first_of_Str_ul(Str.new_CPtr(set), pos); }
	find_first_of_i_ul(ch: number, pos: L = 0): L { return this.find_i_ul(ch, pos); }
	find_first_not_of_Str_ul(set: Str, pos: L = 0): L {
		const b = this.b, n = this.n;
		for (let i = upos(pos); i < n; i++) if (!Str.In(b[i], set)) return i;
		return NPOS;
	}
	find_first_not_of_CPtr_ul(set: CPtr, pos: L = 0): L { return this.find_first_not_of_Str_ul(Str.new_CPtr(set), pos); }
	find_first_not_of_i_ul(ch: number, pos: L = 0): L {
		const c = ch & 0xFF, b = this.b, n = this.n;
		for (let i = upos(pos); i < n; i++) if (b[i] !== c) return i;
		return NPOS;
	}
	find_last_of_Str_ul(set: Str, pos: L = NPOS): L {
		const n = this.n;
		if (n === 0) return NPOS;
		const b = this.b;
		for (let i = umin(pos, n - 1); i >= 0; i--) if (Str.In(b[i], set)) return i;
		return NPOS;
	}
	find_last_of_CPtr_ul(set: CPtr, pos: L = NPOS): L { return this.find_last_of_Str_ul(Str.new_CPtr(set), pos); }
	find_last_of_i_ul(ch: number, pos: L = NPOS): L { return this.rfind_i_ul(ch, pos); }
	find_last_not_of_Str_ul(set: Str, pos: L = NPOS): L {
		const n = this.n;
		if (n === 0) return NPOS;
		const b = this.b;
		for (let i = umin(pos, n - 1); i >= 0; i--) if (!Str.In(b[i], set)) return i;
		return NPOS;
	}
	find_last_not_of_CPtr_ul(set: CPtr, pos: L = NPOS): L { return this.find_last_not_of_Str_ul(Str.new_CPtr(set), pos); }
	find_last_not_of_i_ul(ch: number, pos: L = NPOS): L {
		const n = this.n;
		if (n === 0) return NPOS;
		const c = ch & 0xFF, b = this.b;
		for (let i = umin(pos, n - 1); i >= 0; i--) if (b[i] !== c) return i;
		return NPOS;
	}

	starts_with_Str(s: Str): boolean {
		if (s.n > this.n) return false;
		for (let i = 0; i < s.n; i++) if (this.b[i] !== s.b[i]) return false;
		return true;
	}
	starts_with_CPtr(s: CPtr): boolean { return this.starts_with_Str(Str.new_CPtr(s)); }
	starts_with_i(ch: number): boolean { return this.n > 0 && this.b[0] === (ch & 0xFF); }
	ends_with_Str(s: Str): boolean {
		const n = this.n;
		if (s.n > n) return false;
		for (let i = 0; i < s.n; i++) if (this.b[n - s.n + i] !== s.b[i]) return false;
		return true;
	}
	ends_with_CPtr(s: CPtr): boolean { return this.ends_with_Str(Str.new_CPtr(s)); }
	ends_with_i(ch: number): boolean { return this.n > 0 && this.b[this.n - 1] === (ch & 0xFF); }
	contains_Str(s: Str): boolean { return this.find_Str_ul(s, 0) != NPOS; }
	contains_i(ch: number): boolean { return this.find_i_ul(ch, 0) != NPOS; }

	// ---- comparison
	/** char_traits<char>::compare is memcmp: unsigned bytes, then length. */
	compare_Str(o: Str): number {
		const m = Math.min(this.n, o.n), x = this.b, y = o.b;
		for (let i = 0; i < m; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
		return this.n - o.n;
	}
	compare_CPtr(o: CPtr): number { return this.compare_Str(Str.new_CPtr(o)); }
	compare_ul_ul_Str(pos: L, len: L, o: Str): number { return this.substr(pos, len).compare_Str(o); }
	CompareTo(o: Str): number { return this.compare_Str(o); }
	Equals_Str(o: Str): boolean {
		if (o == null || o.n !== this.n) return false;
		const x = this.b, y = o.b;
		for (let i = 0; i < this.n; i++) if (x[i] !== y[i]) return false;
		return true;
	}
	Equals_o(o: any): boolean { return o instanceof Str && this.Equals_Str(o); }
	GetHashCode(): number { let h = this.n; for (let i = 0; i < this.n; i++) h = (Math.imul(h, 31) + this.b[i]) | 0; return h; }
	/** == a literal: the same bytes up to the literal's NUL. */
	EqLit(p: CPtr): boolean {
		const m = strlen(p);
		if (m !== this.n) return false;
		const x = this.b, y = p.B, o = p.O;
		for (let i = 0; i < m; i++) if (x[i] !== (y[o + i] & 0xFF)) return false;
		return true;
	}

	// ---- operator+
	static Cat_Str_Str(x: Str, y: Str): Str { return Str.new_ucA_i_i(x.b, 0, x.n).append_Str(y); }
	static Cat_Str_CPtr(x: Str, y: CPtr): Str { return Str.new_ucA_i_i(x.b, 0, x.n).append_CPtr(y); }
	static Cat_CPtr_Str(x: CPtr, y: Str): Str { return Str.new_CPtr(x).append_Str(y); }
	static Cat_Str_i(x: Str, ch: number): Str { const r = Str.new_ucA_i_i(x.b, 0, x.n); r.push_back(ch); return r; }
	static Cat_i_Str(ch: number, y: Str): Str { return Str.new_ul_i(1, ch).append_Str(y); }

	/** The n bytes (a copy). */
	Bytes(): Uint8Array { return this.b.slice(0, this.n); }
	/** The bytes as Latin-1 text (C#'s ToString). */
	toString(): string { return latin1(this.b, 0, this.n); }

	begin(): Iter<number> { return Iter.new_TA_l(this.b as any, 0); }
	end(): Iter<number> { return Iter.new_TA_l(this.b as any, this.n); }

	// ---- std::to_string, std::stod and friends (libstdc++: to_string(double) is "%f")
	static to_string_i(v: number): Str { return Str.new_str(String(v)); }
	static to_string_l(v: L): Str { return Str.new_str(String(v)); }
	static to_string_ul(v: L): Str { return Str.new_str(String(v)); }
	static to_string_u(v: number): Str { return Str.new_str(String(v)); }
	static to_string_d(v: number): Str { return Str.new_str(fmtF6(v)); }
	static to_string_f(v: number): Str { return Str.new_str(fmtF6(v)); }

	/** std::stod (libstdc++'s __stoa over strtod): invalid_argument("stod") when nothing converts, out_of_range("stod")
	 *  when strtod sets ERANGE (R.ERange: overflow, or an underflow such as "1e-400" or the inexact subnormal
	 *  2.2250738585072011e-308). idx, unless null, receives the number of characters used. */
	static stod(s: Str, idx: Ptr<L> = Ptr.ZERO): number {
		const p = s.c_str(), end = new Cell<CPtr>(p);
		const R = (cpp as any).R;
		const v: number = R.strtod_CPtr_CPtrr(p, end);
		if (end.v.O === p.O) throw InvalidArgument.new_str("stod");
		if (R.ERange) throw OutOfRange.new_str("stod");
		if (idx != null && !idx.get_IsNull()) idx.ref_Deref().set(end.v.O - p.O);
		return v;
	}
	static stoi(s: Str, idx: Ptr<L> = Ptr.ZERO, bas: number = 10): number {
		const p = s.c_str(), end = new Cell<CPtr>(p);
		const v = strtol10(p, end);
		if (end.v.O === p.O) throw InvalidArgument.new_str("stoi");
		if (v < -2147483648 || v > 2147483647) throw OutOfRange.new_str("stoi");
		if (idx != null && !idx.get_IsNull()) idx.ref_Deref().set(end.v.O - p.O);
		return Number(v);
	}
	static stol(s: Str, idx: Ptr<L> = Ptr.ZERO, bas: number = 10): L {
		const p = s.c_str(), end = new Cell<CPtr>(p);
		const v = strtol10(p, end);
		if (end.v.O === p.O) throw InvalidArgument.new_str("stol");
		if (idx != null && !idx.get_IsNull()) idx.ref_Deref().set(end.v.O - p.O);
		return v;
	}
}
