// a_str.js - part A of the TypeScript runtime (package cpp): C's char* (CPtr, the struct at the top of
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

import { Cell, ArrRef } from './a_ref.js';
import { Ptr, Iter, OutOfRange, InvalidArgument } from './a_std.js';

/** A byte buffer as a CPtr holds one. */


const NPOS = 18446744073709551615n;

/** (int)n of a long or ulong n (an offset). */
function i32(n) { return typeof n === 'number' ? n | 0 : Number(BigInt.asIntN(32, n)); }
/** min(a, k) for a ulong a and a small non-negative k, as a number. */
function umin(a, k) { return typeof a === 'number' ? (a < k ? a : k) : k; }
/** A ulong start position as a number (a bigint is past every string's end). */
function upos(a) { return typeof a === 'number' ? a : Infinity; }

/** strlen: the bytes before the first NUL. */
function strlen(p) {
	const b = p.B;
	let i = p.O;
	while (b[i] !== 0) i++;
	return i - p.O;
}

/** Copy len bytes of src from off into dst at d (src a Uint8Array or a number[] of bytes or sbytes). */
function copyIn(dst, d, src, off, len) {
	if (len <= 0) return;
	if (src === dst) { dst.copyWithin(d, off, off + len); return; }       // memmove, as Array.Copy within one array
	if (len > 32 && src instanceof Uint8Array) { dst.set(src.subarray(off, off + len), d); return; }
	for (let i = 0; i < len; i++) dst[d + i] = src[off + i];
}

/** Latin-1 text of n bytes from off (each byte one character, 0..255). */
function latin1(b, off, n) {
	let s = '';
	for (let i = 0; i < n; i += 8192) {
		const k = Math.min(n - i, 8192), part = new Array(k);
		for (let j = 0; j < k; j++) part[j] = b[off + i + j] & 0xFF;
		s += String.fromCharCode.apply(null, part);
	}
	return s;
}

/** Encoding.Latin1.GetBytes: one byte per character, '?' for a character above U+00FF (a surrogate pair is one). */
function latin1Bytes(s) {
	const r = [];
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
const ids = new WeakMap();
function idHash(o) {
	if (o == null) return 0;
	let v = ids.get(o);
	if (v === undefined) { v = nextId++; ids.set(o, v); }
	return v;
}

/** One element of a char buffer as a reference: reads sign-extend the byte, writes keep the low 8 bits. */
class CPtrRef {
	B;
	k;
	constructor(b, k) { this.B = b; this.k = k; }
	get() { return (this.B[this.k] << 24) >> 24; }
	set(v) { this.B[this.k] = v & 0xFF; }
}

/** C char*: a byte buffer and an offset; null has a null buffer. An immutable value (arithmetic makes a new one). */
export class CPtr {
	B;
	O;
	constructor(b, o) { this.B = b; this.O = o; }

	/** default(CPtr): the null pointer. */
	static ZERO = new CPtr(null, 0);
	static Null = CPtr.ZERO;

	Clone() { return this; }
	get_IsNull() { return this.B == null; }

	/** p[i]: the signed char (-128..127). */
	get(i) { return (this.B[this.O + i] << 24) >> 24; }
	/** p[i] = v: the low byte of v. */
	set(i, v) { this.B[this.O + i] = v & 0xFF; }
	/** A reference to p[i] (reads give the signed char, writes the low byte). */
	ref(i) { return new CPtrRef(this.B, this.O + i); }
	/** The C# indexer under its property names. */
	get_Item(i) { return (this.B[this.O + i] << 24) >> 24; }
	set_Item(i, v) { this.B[this.O + i] = v & 0xFF; }
	ref_Item(i) { return new CPtrRef(this.B, this.O + i); }

	/** A char* made from a std::vector<char> or std::array<char, N> (sbyte storage): the same array. */
	static from_Ptrc(p) { return new CPtr(p.a, p.o); }
	/** A char* made from unsigned char storage: the same array. */
	static from_Ptruc(p) { return new CPtr(p.a, p.o); }

	static op_Add_CPtr_i(p, n) { return new CPtr(p.B, p.O + n); }
	static op_Add_CPtr_l(p, n) { return new CPtr(p.B, p.O + i32(n)); }
	static op_Add_CPtr_ul(p, n) { return new CPtr(p.B, p.O + i32(n)); }
	static op_Sub(p, n) { return new CPtr(p.B, p.O - n); }
	static op_Increment(p) { return new CPtr(p.B, p.O + 1); }
	static op_Decrement(p) { return new CPtr(p.B, p.O - 1); }
	static op_Eq(a, b) { return a.B == null ? b.B == null : (a.B === b.B && a.O === b.O); }
	static op_Ne(a, b) { return !CPtr.op_Eq(a, b); }
	static op_Lt(a, b) { return a.O < b.O; }
	static op_Gt(a, b) { return a.O > b.O; }
	static op_Le(a, b) { return a.O <= b.O; }
	static op_Ge(a, b) { return a.O >= b.O; }
	/** a - b (a long). */
	static Diff(a, b) { return a.O - b.O; }
	Equals_CPtr(o) { return CPtr.op_Eq(this, o); }
	Equals_o(o) { return o instanceof CPtr && CPtr.op_Eq(this, o); }
	GetHashCode() { return (idHash(this.B) ^ this.O) | 0; }
	/** The NUL-terminated bytes as Latin-1 text (or up to the buffer's end), "(null)" for the null pointer. */
	toString() {
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
function fmtF6(v) {
	dv.setFloat64(0, v);
	const hi = dv.getUint32(0), lo = dv.getUint32(4);
	const neg = (hi >>> 31) !== 0, e = (hi >>> 20) & 0x7FF;
	const frac = BigInt(hi & 0xFFFFF) * 4294967296n + BigInt(lo);
	if (e === 0x7FF) return (neg ? "-" : "") + (frac === 0n ? "inf" : "nan");
	const m = e === 0 ? frac : frac + 4503599627370496n;
	const ex = e === 0 ? -1074 : e - 1075;
	let N;
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

function isSpace(c) { return c === 32 || (c >= 9 && c <= 13); }

/** R.strtol as the C# runtime has it (base 10 only; saturates at the long range). */
function strtol10(s, end) {
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
	b;
	/** The length. */
	n;
	/** new Str(): the empty string (C#'s Str()). The arguments are internal: adopt the buffer b holding n bytes. */
	constructor(b, n) { this.b = b === undefined ? new Uint8Array(16) : b; this.n = n === undefined ? 0 : n; }

	static npos = NPOS;

	/** A new string of len bytes of src from off (C#'s Str(byte[], int, int)). */
	static new_ucA_i_i(src, off, len) {
		const b = new Uint8Array(len + 1);
		copyIn(b, 0, src, off, len);
		return new Str(b, len);
	}
	/** The copy constructor. */
	static new_Str(s) { return Str.new_ucA_i_i(s.b, 0, s.n); }
	/** From C# text: Latin-1 bytes. */
	static new_str(s) { const e = latin1Bytes(s); return Str.new_ucA_i_i(e, 0, e.length); }
	static new_CPtr(p) { return Str.new_ucA_i_i(p.B, p.O, strlen(p)); }
	static new_CPtr_ul(p, len) { return Str.new_ucA_i_i(p.B, p.O, Number(len)); }
	static new_ul_i(count, ch) {
		const n = Number(count), b = new Uint8Array(n + 1);
		b.fill(ch & 0xFF, 0, n);
		return new Str(b, n);
	}
	static new_Str_ul_ul(s, pos, len = NPOS) {
		const p = Number(pos), m = umin(len, s.n - p);
		return Str.new_ucA_i_i(s.b, p, m);
	}
	static FromBytes(x) { return Str.new_ucA_i_i(x, 0, x.length); }
	/** const char* -> std::string (C++'s implicit conversion). */
	static from_CPtr(p) { return Str.new_CPtr(p); }

	/** C#'s Reserve: room for need bytes and the NUL (at least doubling). */
	grow_(need) {
		const len = this.b.length;
		if (need + 1 <= len) return;
		const nb = new Uint8Array(Math.max(need + 1, len * 2));
		nb.set(this.b);
		this.b = nb;
	}

	// ---- size, access
	size() { return this.n; }
	length() { return this.n; }
	empty() { return this.n === 0; }
	clear() { this.n = 0; }
	c_str() { this.grow_(this.n); this.b[this.n] = 0; return new CPtr(this.b, 0); }
	data() { return this.c_str(); }
	get_Item_ul(i) { return this.b[Number(i)]; }
	get_Item_l(i) { return this.b[Number(i)]; }
	get_Item_i(i) { return this.b[i]; }
	ref_Item_ul(i) { return new ArrRef(this.b, Number(i)); }
	ref_Item_l(i) { return new ArrRef(this.b, Number(i)); }
	ref_Item_i(i) { return new ArrRef(this.b, i); }
	at(i) {
		if (i >= this.n) throw OutOfRange.new_str("basic_string::at: __n (which is " + i + ") >= this->size() (which is " + this.n + ")");
		return this.b[Number(i)];
	}
	front() { return this.b[0]; }
	ref_front() { return new ArrRef(this.b, 0); }
	back() { return this.b[this.n - 1]; }
	ref_back() { return new ArrRef(this.b, this.n - 1); }
	/** The byte at i as a signed char. */
	Char(i) { return (this.b[Number(i)] << 24) >> 24; }

	// ---- copy, assign, move
	Clone() { return Str.new_ucA_i_i(this.b, 0, this.n); }
	/** ICopy's Assign (the copy assignment from a Str). */
	Assign(o) { this.Assign_Str(o); }
	Assign_Str(o) {
		if (this === o) return;
		this.grow_(o.n);
		copyIn(this.b, 0, o.b, 0, o.n);
		this.n = o.n;
	}
	Assign_CPtr(p) {
		const m = strlen(p), t = new Uint8Array(m + 1);
		copyIn(t, 0, p.B, p.O, m);
		this.b = t; this.n = m;
	}
	Assign_i(ch) { this.grow_(1); this.b[0] = ch & 0xFF; this.n = 1; }
	MoveFrom(o) {
		if (this === o) return;
		this.b = o.b; this.n = o.n;
		o.b = new Uint8Array(16); o.n = 0;
	}
	assign_Str(o) { this.Assign_Str(o); return this; }
	assign_CPtr(p) { this.Assign_CPtr(p); return this; }
	/** assign(first, last). */
	assign_CPtr_CPtr(b0, e0) { return this.assign_CPtr_ul(b0, e0.O - b0.O); }
	assign_Ptrc_Ptrc(b0, e0) { return this.assign_CPtr_ul(CPtr.from_Ptrc(b0), e0.o - b0.o); }
	assign_CPtr_ul(p, len) {
		const m = Number(len), t = new Uint8Array(m + 1);
		copyIn(t, 0, p.B, p.O, m);
		this.b = t; this.n = m;
		return this;
	}
	assign_ul_i(count, ch) {
		const m = Number(count);
		this.grow_(m);
		this.b.fill(ch & 0xFF, 0, m);
		this.n = m;
		return this;
	}

	// ---- append, push, resize
	append_Str(o) {
		const m = o.n;
		this.grow_(this.n + m);
		copyIn(this.b, this.n, o.b, 0, m);
		this.n += m;
		return this;
	}
	append_Str_ul_ul(o, pos, len) {
		const p = Number(pos), m = umin(len, o.n - p);
		this.grow_(this.n + m);
		copyIn(this.b, this.n, o.b, p, m);
		this.n += m;
		return this;
	}
	append_CPtr(p) {
		const m = strlen(p);
		this.grow_(this.n + m);
		copyIn(this.b, this.n, p.B, p.O, m);
		this.n += m;
		return this;
	}
	append_CPtr_ul(p, len) {
		const m = Number(len);
		if (m === 0) return this;           // no bytes, even at a null pointer (the data() of an empty vector)
		this.grow_(this.n + m);
		copyIn(this.b, this.n, p.B, p.O, m);
		this.n += m;
		return this;
	}
	append_ul_i(count, ch) {
		const m = Number(count);
		this.grow_(this.n + m);
		this.b.fill(ch & 0xFF, this.n, this.n + m);
		this.n += m;
		return this;
	}
	append_i(ch) { return this.append_ul_i(1, ch); }
	push_back(ch) { this.grow_(this.n + 1); this.b[this.n++] = ch & 0xFF; }
	pop_back() { this.n--; }
	resize(m, ch = 0) {
		const k = Number(m);
		this.grow_(k);
		if (k > this.n) this.b.fill(ch & 0xFF, this.n, k);
		this.n = k;
	}
	reserve(m) { this.grow_(Number(m)); }
	shrink_to_fit() { }
	/** string_view::remove_prefix / remove_suffix (a view is a Str of its own). */
	remove_prefix(k) { const m = Number(k); this.b.copyWithin(0, m, this.n); this.n -= m; this.b[this.n] = 0; }
	remove_suffix(k) { this.n -= Number(k); this.b[this.n] = 0; }

	// ---- substrings and edits
	substr(pos = 0, len = NPOS) {
		if (pos > this.n) throw OutOfRange.new_str("basic_string::substr: __pos (which is " + pos + ") > this->size() (which is " + this.n + ")");
		const p = Number(pos);
		return Str.new_ucA_i_i(this.b, p, umin(len, this.n - p));
	}
	erase(pos = 0, len = NPOS) {
		const p = Number(pos), m = umin(len, this.n - p);
		this.b.copyWithin(p, p + m, this.n);
		this.n -= m;
		return this;
	}
	insert_ul_Str(pos, s) {
		const p = Number(pos), k = s.n;
		this.grow_(this.n + k);
		this.b.copyWithin(p + k, p, this.n);
		copyIn(this.b, p, s.b, 0, k);
		this.n += k;
		return this;
	}
	insert_ul_CPtr(pos, s) { return this.insert_ul_Str(pos, Str.new_CPtr(s)); }
	insert_ul_ul_i(pos, count, ch) { return this.insert_ul_Str(pos, Str.new_ul_i(count, ch)); }
	replace_ul_ul_Str(pos, len, s) {
		const n = this.n, p = Number(pos), m = umin(len, n - p);
		const t = new Uint8Array(n - m + s.n + 1);
		copyIn(t, 0, this.b, 0, p);
		copyIn(t, p, s.b, 0, s.n);
		copyIn(t, p + s.n, this.b, p + m, n - p - m);
		this.b = t; this.n = n - m + s.n;
		return this;
	}
	replace_ul_ul_CPtr(pos, len, s) { return this.replace_ul_ul_Str(pos, len, Str.new_CPtr(s)); }

	// ---- searching (positions are ulongs; npos when not found)
	static In(c, set) { const b = set.b; for (let i = 0; i < set.n; i++) if (b[i] === c) return true; return false; }

	find_Str_ul(s, pos = 0) {
		const n = this.n, k = s.n, b = this.b, t = s.b;
		if (k === 0) return pos <= n ? pos : NPOS;
		for (let i = upos(pos); i + k <= n; i++) {
			let j = 0;
			while (j < k && b[i + j] === t[j]) j++;
			if (j === k) return i;
		}
		return NPOS;
	}
	find_CPtr_ul(s, pos = 0) { return this.find_Str_ul(Str.new_CPtr(s), pos); }
	find_i_ul(ch, pos = 0) {
		const c = ch & 0xFF, b = this.b, n = this.n;
		for (let i = upos(pos); i < n; i++) if (b[i] === c) return i;
		return NPOS;
	}
	rfind_Str_ul(s, pos = NPOS) {
		const n = this.n, k = s.n, b = this.b, t = s.b;
		if (k > n) return NPOS;
		for (let i = umin(pos, n - k); i >= 0; i--) {
			let j = 0;
			while (j < k && b[i + j] === t[j]) j++;
			if (j === k) return i;
		}
		return NPOS;
	}
	rfind_CPtr_ul(s, pos = NPOS) { return this.rfind_Str_ul(Str.new_CPtr(s), pos); }
	rfind_i_ul(ch, pos = NPOS) {
		const n = this.n;
		if (n === 0) return NPOS;
		const c = ch & 0xFF, b = this.b;
		for (let i = umin(pos, n - 1); i >= 0; i--) if (b[i] === c) return i;
		return NPOS;
	}
	find_first_of_Str_ul(set, pos = 0) {
		const b = this.b, n = this.n;
		for (let i = upos(pos); i < n; i++) if (Str.In(b[i], set)) return i;
		return NPOS;
	}
	find_first_of_CPtr_ul(set, pos = 0) { return this.find_first_of_Str_ul(Str.new_CPtr(set), pos); }
	find_first_of_i_ul(ch, pos = 0) { return this.find_i_ul(ch, pos); }
	find_first_not_of_Str_ul(set, pos = 0) {
		const b = this.b, n = this.n;
		for (let i = upos(pos); i < n; i++) if (!Str.In(b[i], set)) return i;
		return NPOS;
	}
	find_first_not_of_CPtr_ul(set, pos = 0) { return this.find_first_not_of_Str_ul(Str.new_CPtr(set), pos); }
	find_first_not_of_i_ul(ch, pos = 0) {
		const c = ch & 0xFF, b = this.b, n = this.n;
		for (let i = upos(pos); i < n; i++) if (b[i] !== c) return i;
		return NPOS;
	}
	find_last_of_Str_ul(set, pos = NPOS) {
		const n = this.n;
		if (n === 0) return NPOS;
		const b = this.b;
		for (let i = umin(pos, n - 1); i >= 0; i--) if (Str.In(b[i], set)) return i;
		return NPOS;
	}
	find_last_of_CPtr_ul(set, pos = NPOS) { return this.find_last_of_Str_ul(Str.new_CPtr(set), pos); }
	find_last_of_i_ul(ch, pos = NPOS) { return this.rfind_i_ul(ch, pos); }
	find_last_not_of_Str_ul(set, pos = NPOS) {
		const n = this.n;
		if (n === 0) return NPOS;
		const b = this.b;
		for (let i = umin(pos, n - 1); i >= 0; i--) if (!Str.In(b[i], set)) return i;
		return NPOS;
	}
	find_last_not_of_CPtr_ul(set, pos = NPOS) { return this.find_last_not_of_Str_ul(Str.new_CPtr(set), pos); }
	find_last_not_of_i_ul(ch, pos = NPOS) {
		const n = this.n;
		if (n === 0) return NPOS;
		const c = ch & 0xFF, b = this.b;
		for (let i = umin(pos, n - 1); i >= 0; i--) if (b[i] !== c) return i;
		return NPOS;
	}

	starts_with_Str(s) {
		if (s.n > this.n) return false;
		for (let i = 0; i < s.n; i++) if (this.b[i] !== s.b[i]) return false;
		return true;
	}
	starts_with_CPtr(s) { return this.starts_with_Str(Str.new_CPtr(s)); }
	starts_with_i(ch) { return this.n > 0 && this.b[0] === (ch & 0xFF); }
	ends_with_Str(s) {
		const n = this.n;
		if (s.n > n) return false;
		for (let i = 0; i < s.n; i++) if (this.b[n - s.n + i] !== s.b[i]) return false;
		return true;
	}
	ends_with_CPtr(s) { return this.ends_with_Str(Str.new_CPtr(s)); }
	ends_with_i(ch) { return this.n > 0 && this.b[this.n - 1] === (ch & 0xFF); }
	contains_Str(s) { return this.find_Str_ul(s, 0) != NPOS; }
	contains_i(ch) { return this.find_i_ul(ch, 0) != NPOS; }

	// ---- comparison
	/** char_traits<char>::compare is memcmp: unsigned bytes, then length. */
	compare_Str(o) {
		const m = Math.min(this.n, o.n), x = this.b, y = o.b;
		for (let i = 0; i < m; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
		return this.n - o.n;
	}
	compare_CPtr(o) { return this.compare_Str(Str.new_CPtr(o)); }
	compare_ul_ul_Str(pos, len, o) { return this.substr(pos, len).compare_Str(o); }
	CompareTo(o) { return this.compare_Str(o); }
	Equals_Str(o) {
		if (o == null || o.n !== this.n) return false;
		const x = this.b, y = o.b;
		for (let i = 0; i < this.n; i++) if (x[i] !== y[i]) return false;
		return true;
	}
	Equals_o(o) { return o instanceof Str && this.Equals_Str(o); }
	GetHashCode() { let h = this.n; for (let i = 0; i < this.n; i++) h = (Math.imul(h, 31) + this.b[i]) | 0; return h; }
	/** == a literal: the same bytes up to the literal's NUL. */
	EqLit(p) {
		const m = strlen(p);
		if (m !== this.n) return false;
		const x = this.b, y = p.B, o = p.O;
		for (let i = 0; i < m; i++) if (x[i] !== (y[o + i] & 0xFF)) return false;
		return true;
	}

	// ---- operator+
	static Cat_Str_Str(x, y) { return Str.new_ucA_i_i(x.b, 0, x.n).append_Str(y); }
	static Cat_Str_CPtr(x, y) { return Str.new_ucA_i_i(x.b, 0, x.n).append_CPtr(y); }
	static Cat_CPtr_Str(x, y) { return Str.new_CPtr(x).append_Str(y); }
	static Cat_Str_i(x, ch) { const r = Str.new_ucA_i_i(x.b, 0, x.n); r.push_back(ch); return r; }
	static Cat_i_Str(ch, y) { return Str.new_ul_i(1, ch).append_Str(y); }

	/** The n bytes (a copy). */
	Bytes() { return this.b.slice(0, this.n); }
	/** The bytes as Latin-1 text (C#'s ToString). */
	toString() { return latin1(this.b, 0, this.n); }

	begin() { return Iter.new_TA_l(this.b, 0); }
	end() { return Iter.new_TA_l(this.b, this.n); }

	// ---- std::to_string, std::stod and friends (libstdc++: to_string(double) is "%f")
	static to_string_i(v) { return Str.new_str(String(v)); }
	static to_string_l(v) { return Str.new_str(String(v)); }
	static to_string_ul(v) { return Str.new_str(String(v)); }
	static to_string_u(v) { return Str.new_str(String(v)); }
	static to_string_d(v) { return Str.new_str(fmtF6(v)); }
	static to_string_f(v) { return Str.new_str(fmtF6(v)); }

	/** std::stod (libstdc++'s __stoa over strtod): invalid_argument("stod") when nothing converts, out_of_range("stod")
	 *  when strtod sets ERANGE (R.ERange: overflow, or an underflow such as "1e-400" or the inexact subnormal
	 *  2.2250738585072011e-308). idx, unless null, receives the number of characters used. */
	static stod(s, idx = Ptr.ZERO) {
		const p = s.c_str(), end = new Cell(p);
		const R = (cpp).R;
		const v = R.strtod_CPtr_CPtrr(p, end);
		if (end.v.O === p.O) throw InvalidArgument.new_str("stod");
		if (R.ERange) throw OutOfRange.new_str("stod");
		if (idx != null && !idx.get_IsNull()) idx.ref_Deref().set(end.v.O - p.O);
		return v;
	}
	static stoi(s, idx = Ptr.ZERO, bas = 10) {
		const p = s.c_str(), end = new Cell(p);
		const v = strtol10(p, end);
		if (end.v.O === p.O) throw InvalidArgument.new_str("stoi");
		if (v < -2147483648 || v > 2147483647) throw OutOfRange.new_str("stoi");
		if (idx != null && !idx.get_IsNull()) idx.ref_Deref().set(end.v.O - p.O);
		return Number(v);
	}
	static stol(s, idx = Ptr.ZERO, bas = 10) {
		const p = s.c_str(), end = new Cell(p);
		const v = strtol10(p, end);
		if (end.v.O === p.O) throw InvalidArgument.new_str("stol");
		if (idx != null && !idx.get_IsNull()) idx.ref_Deref().set(end.v.O - p.O);
		return v;
	}
}
// (ts/src/cpp/a_str.ts without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)
