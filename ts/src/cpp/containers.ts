// containers.ts - std::unordered_map / unordered_set with libstdc++'s exact node order (GCC 13 bits/hashtable.h:
// one singly linked list, a bucket array pointing at the node before each bucket's first node, new nodes at the
// front of their bucket, the prime rehash policy with growth factor 2), std::hash as libstdc++ computes it
// (identity for integers, _Hash_bytes for strings), std::map / std::set (sorted), std::stack, std::queue and their
// iterators. Port of the C# Cpp containers (cs/runtime/Containers.cs, the specification).
//
// Hash codes are size_t: a node keeps its code as two exact 32-bit halves (h, l), and _Hash_bytes runs on 32-bit
// halves too, so neither hashing nor bucket selection ever rounds (HNode.code gives the code as a cpp.L). A
// container's default hasher and key-equal (C#: StdHash.For<K>() and EqualityComparer<K>.Default, chosen by the
// static type K) are chosen here by the key's value, which the erased generics leave as the only evidence: an
// integer number or a bigint hashes as its value mod 2^64 (libstdc++ hashes every integer type that way), a Str by
// _Hash_bytes, anything else by identity. tests/stdcheck (hashcheck.mts, containercheck.mts, run_ts.sh) compares
// the order with libstdc++'s.
//
// Where this differs from the C# on purpose:
// - Less<T>.Fn on numbers is the primitive a < b (C++'s std::less; C#'s Comparer<double> puts NaN first). Values
//   with no order of their own (engine objects: std::set<const Column*>, which C++ orders by address) get a fixed
//   identity order (C#'s Comparer throws on them); the identity hash is a per-object sequence number (C#:
//   RuntimeHelpers.GetHashCode; libstdc++: the address, which no port reproduces).
// - A floating-point key (the engine has none) hashes as an integer when its value is integral.
// - The hash of a key is computed once per operation (the C# Insert and operator[] compute it again; hashers are
//   pure). RehashPolicy.NeedRehash returns the new bucket count or 0 (C#: the pair (bool, n)). HNode.code is a
//   getter over (h, l). UMapC / USetC make their H and E with the translator's makers, once per container (C#: once
//   per type, new H()).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.
import * as cpp from './index.js';
import { PrimeList } from './primelist.js';

type L = number | bigint;

const JSSet = globalThis.Set;
const TWO32 = 4294967296;
const SAFE = 9007199254740991;
const ULMAX = 18446744073709551615n;

// ---- 64-bit arithmetic on 32-bit halves (the results are left in rh, rl) ----

let rh = 0, rl = 0;

/** (ah:al) * (bh:bl) mod 2^64, exact. */
function mul64(ah: number, al: number, bh: number, bl: number): void {
	const a0 = al & 0xffff, a1 = al >>> 16, b0 = bl & 0xffff, b1 = bl >>> 16;
	const mid = a0 * b1 + a1 * b0;                         // < 2^33
	const lo = a0 * b0 + (mid % 65536) * 65536;            // < 2^33
	const hi = a1 * b1 + Math.floor(mid / 65536) + Math.floor(lo / TWO32);   // high half of al * bl
	rl = lo >>> 0;
	rh = (hi + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0;
}

/** The exact value h * 2^32 + l as a cpp.L (a number when it is a safe integer). */
function hlToL(h: number, l: number): L {
	return h < 0x200000 ? h * TWO32 + l : (BigInt(h) << 32n) | BigInt(l);
}

/** Splits a long or ulong value (taken mod 2^64) into rh, rl. */
function splitL(x: L): void {
	if (typeof x === 'number') {
		rl = x >>> 0;
		rh = Math.floor(x / TWO32) >>> 0;
	} else {
		const u = BigInt.asUintN(64, x);
		rl = Number(u & 0xffffffffn);
		rh = Number(u >> 32n);
	}
}

/** (h * 2^32 + l) mod n, exact for n < 2^37. */
function modHL(h: number, l: number, n: number): number {
	if (h === 0) return l % n;
	if (n <= 0x200000) return ((h % n) * TWO32 + l) % n;
	const r = ((h % n) * 65536) % n;
	return (((r * 65536) % n) + l) % n;
}

// ---- std::_Hash_bytes (libsupc++/hash_bytes.cc, the 64-bit branch) ----

const MH = 0xc6a4a793, ML = 0x5bd1e995;     // 0xc6a4a7935bd1e995
const SEED = 0xc70f6907;

/** _Hash_bytes(b[off..off+len), seed sh:sl), the result in rh, rl. b holds bytes (0..255). */
function hashBytesHL(b: ArrayLike<number>, off: number, len: number, sh: number, sl: number): void {
	mul64(0, len >>> 0, MH, ML);
	let hh = (sh ^ rh) >>> 0, hl = (sl ^ rl) >>> 0;          // seed ^ (len * mul)
	const end = off + (len - (len & 7));
	let p = off;
	for (; p < end; p += 8) {
		const dl = ((b[p] & 0xff) | ((b[p + 1] & 0xff) << 8) | ((b[p + 2] & 0xff) << 16) | ((b[p + 3] & 0xff) << 24)) >>> 0;
		const dh = ((b[p + 4] & 0xff) | ((b[p + 5] & 0xff) << 8) | ((b[p + 6] & 0xff) << 16) | ((b[p + 7] & 0xff) << 24)) >>> 0;
		mul64(dh, dl, MH, ML);                                // data * mul
		rl = (rl ^ (rh >>> 15)) >>> 0;                        // shift_mix
		mul64(rh, rl, MH, ML);                                // * mul
		mul64((hh ^ rh) >>> 0, (hl ^ rl) >>> 0, MH, ML);      // (hash ^ data) * mul
		hh = rh; hl = rl;
	}
	const rest = len & 7;
	if (rest !== 0) {
		let dl = 0, dh = 0;                                   // load_bytes: the rest, little-endian
		for (let i = rest - 1; i >= 0; i--) {
			const v = b[p + i] & 0xff;
			if (i >= 4) dh = dh * 256 + v; else dl = dl * 256 + v;
		}
		mul64((hh ^ dh) >>> 0, (hl ^ dl) >>> 0, MH, ML);
		hh = rh; hl = rl;
	}
	mul64(hh, (hl ^ (hh >>> 15)) >>> 0, MH, ML);              // shift_mix(hash) * mul
	rl = (rl ^ (rh >>> 15)) >>> 0;                            // shift_mix
}

// ---- identity: the hash and order of objects with neither (libstdc++ uses addresses) ----

const ids = new WeakMap<object, number>();
let nextId = 0;
function idOf(o: object): number {
	let v = ids.get(o);
	if (v === undefined) { v = ++nextId; ids.set(o, v); }
	return v;
}

// ---- std::hash, EqualityComparer<T>.Default and std::less by value ----

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);
let latin = new Uint8Array(64);

/** std::hash of a key by its value (C#: StdHash.For<K>()), the code in rh, rl. */
function hashValue(k: any): void {
	switch (typeof k) {
		case 'number':
			if (Number.isInteger(k)) { splitL(k); return; }
			// a double (the engine has no floating-point keys): _Hash_bytes of its 8 bytes, 0 for +-0
			f64[0] = k;
			hashBytesHL(f64b, 0, 8, 0, SEED);
			return;
		case 'bigint': splitL(k); return;
		case 'boolean': rh = 0; rl = k ? 1 : 0; return;
		case 'object':
			if (k === null) { rh = 0; rl = 0; return; }
			if (k instanceof cpp.Str) { hashBytesHL(k.b, 0, k.n, 0, SEED); return; }
			rh = 0; rl = idOf(k); return;
		case 'function': rh = 0; rl = idOf(k); return;
		case 'string': {
			const n = k.length;
			if (latin.length < n) latin = new Uint8Array(n * 2);
			for (let i = 0; i < n; i++) latin[i] = k.charCodeAt(i) & 0xff;
			hashBytesHL(latin, 0, n, 0, SEED);
			return;
		}
		default: rh = 0; rl = 0; return;
	}
}

function strEq(a: any, b: any): boolean {
	const n = a.n;
	if (b.n !== n) return false;
	const x = a.b, y = b.b;
	for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
	return true;
}

/** char_traits<char>::compare: unsigned bytes, then length (Str.compare). */
function strCompare(a: any, b: any): number {
	const n = a.n, m = b.n, k = n < m ? n : m;
	const x = a.b, y = b.b;
	for (let i = 0; i < k; i++) {
		const p = x[i] & 0xff, q = y[i] & 0xff;
		if (p !== q) return p < q ? -1 : 1;
	}
	return n - m;
}

/** EqualityComparer<T>.Default.Equals: numbers by value (NaN equals NaN, as double.Equals has it), a Str by its
 *  bytes, the runtime structs with operator == (CPtr, Ptr, Iter, RevIter, MIt) and TupN by theirs, another runtime
 *  value overriding Equals(object) by its Equals_o, everything else (engine objects, Pair) by identity. */
function eqValue(a: any, b: any): boolean {
	if (a === b) return true;
	switch (typeof a) {
		case 'number': {
			const t = typeof b;
			if (t !== 'number' && t !== 'bigint') return false;
			return a == b || (a !== a && b !== b);
		}
		case 'bigint': {
			const t = typeof b;
			return (t === 'number' || t === 'bigint') && a == b;
		}
		case 'object': {
			if (a === null || b == null) return false;
			if (a instanceof cpp.Str) return b instanceof cpp.Str && strEq(a, b);
			const C = a.constructor;
			if (C === MIt || C === cpp.CPtr || C === cpp.Ptr || C === cpp.Iter || C === cpp.RevIter)
				return b.constructor === C && C.op_Eq(a, b);
			if (C === cpp.TupN) return b instanceof cpp.TupN && (a as any).CompareTo(b) === 0;
			if (typeof a.Equals_o === 'function') return a.Equals_o(b);
			return false;
		}
		default: return false;
	}
}

/** std::less: numbers (and enums) with the primitive a < b, a Str as std::string compares, a Pair first then
 *  second, a value with CompareTo (TupN, FsPath) by it, false before true, null first; objects with no order of
 *  their own (std::set<const Column*>, which C++ orders by address) by a fixed identity order. */
function lessValue(a: any, b: any): boolean {
	switch (typeof a) {
		case 'number': case 'bigint': return a < b;
		case 'object':
			if (a === null) return b != null;
			if (b == null) return false;
			if (a instanceof cpp.Str) return strCompare(a, b) < 0;
			if (a instanceof cpp.Pair) {
				if (lessValue(a.first, b.first)) return true;
				if (lessValue(b.first, a.first)) return false;
				return lessValue(a.second, b.second);
			}
			if (typeof a.CompareTo === 'function') return a.CompareTo(b) < 0;
			return a !== b && idOf(a) < idOf(b);
		case 'boolean': return !a && b === true;
		case 'string': return a < b;
		case 'undefined': return b != null;
		case 'function': return a !== b && idOf(a) < idOf(b);
		default: return false;
	}
}

// ---- element copies (C#: Elem<T>.Copy, KeyCopy<T>.Of) ----

let runtimeCtors: { has(x: unknown): boolean } | null = null;
/** Whether x is an object of a runtime class (one the cpp module exports; C#: namespace Cpp). */
function isRuntimeObj(x: any): boolean {
	if (runtimeCtors === null) {
		const s = new JSSet<unknown>();
		for (const v of Object.values(cpp)) if (typeof v === 'function') s.add(v);
		runtimeCtors = s;
	}
	return runtimeCtors.has(x.constructor);
}

/** Elem<T>.Copy: an object with Clone (ICopy) is cloned, an array copied deeply, any other value is itself. */
function elemCopy<T>(x: T): T {
	if (x === null || typeof x !== 'object') return x;
	if (Array.isArray(x)) return arrDeep(x) as any;
	if (ArrayBuffer.isView(x)) return (x as any).slice();
	const c = (x as any).Clone;
	return typeof c === 'function' ? c.call(x) : x;
}

function arrDeep(a: any[]): any[] {
	const b = a.slice();
	for (let i = 0; i < a.length; i++) { const v = a[i]; if (v != null && typeof v === 'object') b[i] = elemCopy(v); }
	return b;
}

/** KeyCopy<T>.Of: a key that is a runtime value (Str, Pair, Vec, TupN, ...) is the container's own copy; an engine
 *  object (a pointer in C++) is stored as it is. */
function keyCopy<T>(x: T): T {
	if (x !== null && typeof x === 'object' && isRuntimeObj(x)) {
		const c = (x as any).Clone;
		if (typeof c === 'function') return c.call(x);
	}
	return x;
}

function pairClone(p: any): any { return p.Clone(); }
function same<T>(x: T): T { return x; }
function pairFirst(p: any): any { return p.first; }

function outOfRange(msg: string): never {
	const O: any = cpp.OutOfRange;
	if (typeof O.new_str === 'function') throw O.new_str(msg);
	throw O.new_Str(cpp.Str.new_CPtr(cpp.R.Lit(msg)));
}

/** A reference to a pair's mapped value (the ref V the C# operator[] and at() return). */
class SecondRef<V> {
	p: any;
	constructor(p: any) { this.p = p; }
	get(): V { return this.p.second; }
	set(v: V): void { this.p.second = v; }
}

function addU(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= SAFE) return r; }
	const r = BigInt.asUintN(64, BigInt(a) + BigInt(b));
	return r <= BigInt(SAFE) ? Number(r) : r;
}

function mulU(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= SAFE) return r; }
	const r = BigInt.asUintN(64, BigInt(a) * BigInt(b));
	return r <= BigInt(SAFE) ? Number(r) : r;
}

/** (ulong) of a non-negative integral double. */
function d2ul(x: number): L {
	return x <= SAFE ? x : BigInt.asUintN(64, BigInt(x));
}

// ---- the public classes ----

export class StdHash {
	/** libstdc++'s std::_Hash_bytes (libsupc++/hash_bytes.cc, the 64-bit branch). */
	static HashBytes(b: ArrayLike<number>, off: number, len: number, seed: L): L {
		splitL(seed);
		hashBytesHL(b, off, len, rh, rl);
		return hlToL(rh, rl);
	}
	static Of_Str(s: cpp.Str): L { hashBytesHL(s.b as any, 0, s.n, 0, SEED); return hlToL(rh, rl); }
	static Of_i(v: number): L { splitL(v); return hlToL(rh, rl); }
	static Of_l(v: L): L { splitL(v); return hlToL(rh, rl); }
	static Of_u(v: number): L { return v; }
	static Of_ul(v: L): L { return v; }
	/** StdHash.For<K>(): std::hash<K>, by the key's value (see the header). */
	static For<K>(): (k: K) => L { return stdHashOf; }
}

function stdHashOf(k: any): L { hashValue(k); return hlToL(rh, rl); }

export class Hash<T> {
	static Of(x: any): L { return stdHashOf(x); }
	op_Call(x: T): L { return stdHashOf(x); }
}

export class EqualTo<T> {
	op_Call(a: T, b: T): boolean { return eqValue(a, b); }
}

export class Less<T> {
	/** Less<T>.Fn, one function for every T (the engine passes it where the C# passes Less<double>.Fn, ...). */
	static Fn: (a: any, b: any) => boolean = lessValue;
	op_Call(a: T, b: T): boolean { return lessValue(a, b); }
}

const FAST_BKT = [2, 2, 2, 3, 5, 5, 7, 7, 11, 11, 11, 11, 13, 13];

/** The prime rehash policy (libstdc++ src/c++11/hashtable_c++0x.cc and hashtable-aux.cc). */
export class RehashPolicy {
	MaxLoad: number = 1.0;
	NextResize: L = 0;

	NextBkt(n: L): L {
		if (n < FAST_BKT.length) {
			const k = Number(n);
			if (k === 0) return 1;
			this.NextResize = d2ul(Math.floor(FAST_BKT[k] * this.MaxLoad));
			return FAST_BKT[k];
		}
		const primes = PrimeList.P;
		const last = primes.length - 1;          // __prime_list + __n_primes - 1 (the sentinel is excluded)
		let lo = 6, hi = last;
		while (lo < hi) { const mid = (lo + hi) >>> 1; if (primes[mid] < n) lo = mid + 1; else hi = mid; }
		if (lo === last) this.NextResize = ULMAX;
		else this.NextResize = d2ul(Math.floor(Number(primes[lo]) * this.MaxLoad));
		return primes[lo];
	}

	BktForElements(n: L): L { return d2ul(Math.ceil(Number(n) / this.MaxLoad)); }

	/** _M_need_rehash: the new bucket count, or 0 for no rehash (C#: the pair (true, n) / (false, 0)). */
	NeedRehash(nBkt: L, nElt: L, nIns: L): L {
		const tot = addU(nElt, nIns);
		if (tot > this.NextResize) {
			const floor0: L = this.NextResize != 0 ? 0 : 11;
			const minBkts = Number(tot > floor0 ? tot : floor0) / this.MaxLoad;
			if (minBkts >= Number(nBkt)) {
				const a = addU(d2ul(Math.floor(minBkts)), 1), b = mulU(nBkt, 2);
				return this.NextBkt(a > b ? a : b);
			}
			this.NextResize = d2ul(Math.floor(Number(nBkt) * this.MaxLoad));
			return 0;
		}
		return 0;
	}
}

/** A hash table node; the before-begin sentinel is a node too. The hash code is kept as two 32-bit halves. */
export class HNode<E> {
	next: HNode<E> | null = null;
	val: E = null;
	h: number = 0;
	l: number = 0;
	/** The cached hash code (C#: ulong code). */
	get code(): L { return hlToL(this.h, this.l); }
}

function newBuckets<E>(n: number): (HNode<E> | null)[] {
	const a = new Array<HNode<E> | null>(n);
	for (let i = 0; i < n; i++) a[i] = null;
	return a;
}

/** libstdc++'s _Hashtable for unique keys. E is the stored element (Pair<K, V> or K). */
export class HashTable<K, E> {
	key: (e: E) => K;
	/** The hasher (Func<K, ulong>); null: std::hash<K>, by the key's value. */
	hash: ((k: K) => L) | null;
	eq: (a: K, b: K) => boolean;
	buckets: (HNode<E> | null)[];
	beforeBegin: HNode<E>;
	nelem: number;
	pol: RehashPolicy;

	constructor(key: (e: E) => K, hash: ((k: K) => L) | null, eq: ((a: K, b: K) => boolean) | null) {
		this.key = key;
		this.hash = hash != null ? hash : null;
		this.eq = eq != null ? eq : eqValue;
		this.buckets = newBuckets<E>(1);
		this.beforeBegin = new HNode<E>();
		this.nelem = 0;
		this.pol = new RehashPolicy();
	}

	/** The hash code of k, into rh, rl. */
	codeOf(k: K): void {
		const h = this.hash;
		if (h === null) hashValue(k); else splitL(h(k));
	}

	/** The node holding k (whose code is h:l), or null. */
	findNode(k: K, h: number, l: number): HNode<E> | null {
		const bs = this.buckets, n = bs.length;
		const b = modHL(h, l, n);
		const before = bs[b];
		if (before == null) return null;
		for (let p = before.next; p !== null; p = p.next) {
			if (p.h === h && p.l === l && this.eq(k, this.key(p.val))) return p;
			const nx = p.next;
			if (nx === null || modHL(nx.h, nx.l, n) !== b) break;
		}
		return null;
	}

	Find(k: K): HNode<E> | null {
		this.codeOf(k);
		return this.findNode(k, rh, rl);
	}

	/** Adds e, whose key is absent and has the code h:l: the rehash check, then the node at its bucket's front. */
	link(e: E, h: number, l: number): HNode<E> {
		const n = this.pol.NeedRehash(this.buckets.length, this.nelem, 1);
		if (n != 0) this.Rehash(n);
		const node = new HNode<E>();
		node.val = e;
		node.h = h;
		node.l = l;
		this.insertBucketBegin(modHL(h, l, this.buckets.length), node);
		this.nelem++;
		return node;
	}

	/** Inserts e if its key is absent; returns the node holding the key. */
	Insert(e: E): HNode<E> {
		const k = this.key(e);
		this.codeOf(k);
		const h = rh, l = rl;
		const found = this.findNode(k, h, l);
		if (found !== null) return found;
		return this.link(e, h, l);
	}

	insertBucketBegin(b: number, node: HNode<E>): void {
		const bs = this.buckets;
		const prev = bs[b];
		if (prev != null) {
			node.next = prev.next;
			prev.next = node;
		} else {
			node.next = this.beforeBegin.next;
			this.beforeBegin.next = node;
			if (node.next !== null) bs[modHL(node.next.h, node.next.l, bs.length)] = node;
			bs[b] = this.beforeBegin;
		}
	}

	/** _M_rehash_aux for unique keys: relink every node into n buckets, keeping each bucket's order. */
	Rehash(n: L): void {
		const m = Number(n);
		const nb = newBuckets<E>(m);
		const bb = this.beforeBegin;
		let p = bb.next;
		bb.next = null;
		let bbeginBkt = 0;
		while (p !== null) {
			const next = p.next;
			const b = modHL(p.h, p.l, m);
			const q = nb[b];
			if (q === null) {
				p.next = bb.next;
				bb.next = p;
				nb[b] = bb;
				if (p.next !== null) nb[bbeginBkt] = p;
				bbeginBkt = b;
			} else {
				p.next = q.next;
				q.next = p;
			}
			p = next;
		}
		this.buckets = nb;
	}

	EraseKey(k: K): boolean {
		this.codeOf(k);
		const h = rh, l = rl;
		const bs = this.buckets, n = bs.length;
		const b = modHL(h, l, n);
		let prev = bs[b];
		if (prev == null) return false;
		let p = prev.next;
		while (p !== null && !(p.h === h && p.l === l && this.eq(k, this.key(p.val)))) {
			if (p.next === null || modHL(p.next.h, p.next.l, n) !== b) return false;
			prev = p;
			p = p.next;
		}
		if (p === null) return false;
		this.eraseNode(b, prev, p);
		return true;
	}

	eraseNode(b: number, prev: HNode<E>, n: HNode<E>): void {
		const bs = this.buckets, nb = bs.length;
		if (prev === bs[b]) {
			// removing the bucket's first node (_M_remove_bucket_begin)
			const next = n.next;
			const nextBkt = next !== null ? modHL(next.h, next.l, nb) : 0;
			if (next === null || nextBkt !== b) {
				if (next !== null) bs[nextBkt] = bs[b];
				if (bs[b] === this.beforeBegin) this.beforeBegin.next = next;
				bs[b] = null;
			}
		} else if (n.next !== null) {
			const nextBkt = modHL(n.next.h, n.next.l, nb);
			if (nextBkt !== b) bs[nextBkt] = prev;
		}
		prev.next = n.next;
		this.nelem--;
	}

	EraseAt(n: HNode<E>): void {
		const b = modHL(n.h, n.l, this.buckets.length);
		let prev = this.buckets[b];
		while (prev.next !== n) prev = prev.next;
		this.eraseNode(b, prev, n);
	}

	size(): L { return this.nelem; }
	empty(): boolean { return this.nelem === 0; }
	/** Keeps the bucket count, as libstdc++'s clear does. */
	clear(): void { this.buckets = newBuckets<E>(this.buckets.length); this.beforeBegin.next = null; this.nelem = 0; }
	bucket_count(): L { return this.buckets.length; }

	reserve(n: L): void { this.rehash(this.pol.BktForElements(n)); }
	/** _M_rehash_policy._M_next_bkt(max(n, bkt_for_elements(size + 1))), only if it differs. */
	rehash(n: L): void {
		const m = this.pol.BktForElements(this.nelem + 1);
		const want = this.pol.NextBkt(n > m ? n : m);
		if (want != this.buckets.length) this.Rehash(want);
	}

	/** The elements in node order; like the C# iterator, each step reads the next link only when the loop asks for
	 *  the next element. */
	*Items(): Generator<E, void, unknown> {
		for (let p = this.beforeBegin.next; p !== null; p = p.next) yield p.val;
	}

	begin(): MIt<E> { return new MIt<E>(this.beforeBegin.next, null, 0); }
	end(): MIt<E> { return MIt.ZERO as MIt<E>; }
	find(k: K): MIt<E> { return new MIt<E>(this.Find(k), null, 0); }
	count_(k: K): L { return this.Find(k) !== null ? 1 : 0; }
	count(k: K): L { return this.Find(k) !== null ? 1 : 0; }
	contains(k: K): boolean { return this.Find(k) !== null; }
	erase_K(k: K): L { return this.EraseKey(k) ? 1 : 0; }
	erase_MItE(it: MIt<E>): MIt<E> { const nx = it.node.next; this.EraseAt(it.node); return new MIt<E>(nx, null, 0); }

	/** _M_assign: the same bucket count, the same node order, each element copied by copy. */
	CopyFrom(o: HashTable<K, E>, copy: (e: E) => E): void {
		const bs = newBuckets<E>(o.buckets.length), nb = bs.length;
		this.buckets = bs;
		this.beforeBegin.next = null;
		this.nelem = 0;
		this.pol.NextResize = o.pol.NextResize;
		let prev = this.beforeBegin;
		for (let p = o.beforeBegin.next; p !== null; p = p.next) {
			const n = new HNode<E>();
			n.val = copy(p.val);
			n.h = p.h;
			n.l = p.l;
			prev.next = n;
			const b = modHL(n.h, n.l, nb);
			if (bs[b] === null) bs[b] = prev;
			prev = n;
			this.nelem++;
		}
	}
}

/** An iterator over a hashed or sorted container: a node (null at end) or a position in a sorted container's list.
 *  A struct in C#, so an immutable value here; ZERO is its default. */
export class MIt<E> {
	static ZERO: MIt<any> = new MIt<any>(null, null, 0);
	readonly node: HNode<E> | null;
	readonly list: E[] | null;
	readonly pos: number;
	constructor(node: HNode<E> | null, list: E[] | null, pos: number) { this.node = node; this.list = list; this.pos = pos; }
	static new_HNodeE<E>(n: HNode<E> | null): MIt<E> { return new MIt<E>(n, null, 0); }
	static new_ListE_i<E>(l: E[], p: number): MIt<E> { return new MIt<E>(null, l, p); }
	/** A value: copying it is the copy. */
	Clone(): MIt<E> { return this; }
	get_Deref(): E { return this.list !== null ? this.list[this.pos] : this.node.val; }
	static op_Increment<E>(x: MIt<E>): MIt<E> { return x.list !== null ? new MIt<E>(null, x.list, x.pos + 1) : new MIt<E>(x.node.next, null, 0); }
	static op_Decrement<E>(x: MIt<E>): MIt<E> { return new MIt<E>(null, x.list, x.pos - 1); }
	/** A list position compares by position (a hashed container's iterator counts as no position); two nodes by
	 *  identity. */
	static op_Eq<E>(a: MIt<E>, b: MIt<E>): boolean {
		if (a.list !== null || b.list !== null) return posOf(a) === posOf(b);
		return a.node === b.node;
	}
	static op_Ne<E>(a: MIt<E>, b: MIt<E>): boolean { return !MIt.op_Eq(a, b); }
	Equals_MItE(o: MIt<E>): boolean { return MIt.op_Eq(this, o); }
	Equals_o(o: any): boolean { return o instanceof MIt && MIt.op_Eq(this, o); }
	GetHashCode(): number { return this.pos; }
}

function posOf(x: MIt<any>): number { return x.list !== null ? x.pos : 2147483647; }

function res<E>(n: HNode<E>, added: boolean): cpp.Pair<MIt<E>, boolean> {
	return cpp.Pair.new_A_B(new MIt<E>(n, null, 0), added);
}

export class UMap<K, V> extends HashTable<K, cpp.Pair<K, V>> {
	/** How to make a mapped value (the translator's maker; C#: an explicit maker or Elem<V>.Make). */
	mk: (() => V) | null;

	/** UMap(h, eq, mk): h null is std::hash<K>, eq null std::equal_to<K>. */
	constructor(h?: ((k: K) => L) | null, eq?: ((a: K, b: K) => boolean) | null, mk?: (() => V) | null) {
		super(pairFirst, h, eq);
		this.mk = mk != null ? mk : null;
	}
	static new_FuncKul_FuncKKb_FuncV<K, V>(h: ((k: K) => L) | null, eq: ((a: K, b: K) => boolean) | null, mk: (() => V) | null): UMap<K, V> {
		return new UMap<K, V>(h, eq, mk);
	}
	/** UMap(initializer list, h, eq) + the maker of V: each pair copied in, a repeated key keeping the first. */
	static new_PairKVA_FuncKul_FuncKKb<K, V>(il: cpp.Pair<K, V>[], h: ((k: K) => L) | null, eq: ((a: K, b: K) => boolean) | null, mk?: (() => V) | null): UMap<K, V> {
		const m = new UMap<K, V>(h, eq, mk);
		for (const p of il) m.Insert(p.Clone());
		return m;
	}

	MakeV(): V { const mk = this.mk; return mk !== null ? mk() : null; }

	/** operator[]: the node for k, inserted with a made value if absent (the map owns a copy of the key). */
	indexNode(k: K): HNode<cpp.Pair<K, V>> {
		this.codeOf(k);
		const h = rh, l = rl;
		let f = this.findNode(k, h, l);
		if (f === null) f = this.link(cpp.Pair.new_A_B(keyCopy(k), this.MakeV()), h, l);
		return f;
	}
	/** operator[] read as a value. */
	Index(k: K): V { return this.indexNode(k).val.second; }
	/** operator[] as a reference. */
	ref_Index(k: K): cpp.Ref<V> { return new SecondRef<V>(this.indexNode(k).val); }

	atNode(k: K): HNode<cpp.Pair<K, V>> {
		const f = this.Find(k);
		if (f === null) outOfRange("_Map_base::at");
		return f;
	}
	at(k: K): V { return this.atNode(k).val.second; }
	ref_at(k: K): cpp.Ref<V> { return new SecondRef<V>(this.atNode(k).val); }

	/** insert(k, v) if k is absent, the key copied in. */
	insertKV(k: K, v: V): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> {
		this.codeOf(k);
		const h = rh, l = rl;
		const f = this.findNode(k, h, l);
		if (f !== null) return res(f, false);
		return res(this.link(cpp.Pair.new_A_B(keyCopy(k), v), h, l), true);
	}

	insert(p: cpp.Pair<K, V>): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> { return this.insertKV(p.first, p.second); }
	emplace_K_V(k: K, v: V): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> { return this.insertKV(k, v); }
	emplace_PairKV(p: cpp.Pair<K, V>): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> { return this.insertKV(p.first, p.second); }
	try_emplace_K_V(k: K, v: V): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> { return this.insertKV(k, v); }
	try_emplace_K(k: K): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> { return this.insertKV(k, this.MakeV()); }
	insert_or_assign(k: K, v: V): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> {
		const f = this.Find(k);
		if (f !== null) { f.val.second = v; return res(f, false); }
		return this.insertKV(k, v);
	}

	Clone(): UMap<K, V> { const m = new UMap<K, V>(this.hash, this.eq, this.mk); m.CopyFrom(this, pairClone); return m; }
	Assign(o: UMap<K, V>): void { if (this !== o) this.CopyFrom(o, pairClone); }
	MoveFrom(o: UMap<K, V>): void { if (this !== o) { this.CopyFrom(o, same); o.clear(); } }
}

export class USet<T> extends HashTable<T, T> {
	/** USet(h, eq): h null is std::hash<T>, eq null std::equal_to<T>. */
	constructor(h?: ((k: T) => L) | null, eq?: ((a: T, b: T) => boolean) | null) { super(same, h, eq); }
	static new_FuncTul_FuncTTb<T>(h: ((k: T) => L) | null, eq: ((a: T, b: T) => boolean) | null): USet<T> { return new USet<T>(h, eq); }
	/** USet(initializer list, h, eq). */
	static new_TA_FuncTul_FuncTTb<T>(il: T[], h: ((k: T) => L) | null, eq: ((a: T, b: T) => boolean) | null): USet<T> {
		const s = new USet<T>(h, eq);
		for (const x of il) s.Insert(x);
		return s;
	}

	insert(x: T): cpp.Pair<MIt<T>, boolean> {
		this.codeOf(x);
		const h = rh, l = rl;
		const f = this.findNode(x, h, l);
		if (f !== null) return res(f, false);
		return res(this.link(keyCopy(x), h, l), true);
	}
	emplace(x: T): cpp.Pair<MIt<T>, boolean> { return this.insert(x); }

	Clone(): USet<T> { const m = new USet<T>(this.hash, this.eq); m.CopyFrom(this, elemCopy); return m; }
	Assign(o: USet<T>): void { if (this !== o) this.CopyFrom(o, elemCopy); }
	MoveFrom(o: USet<T>): void { if (this !== o) { this.CopyFrom(o, same); o.clear(); } }
}

/** A hasher of the engine's own (struct CiHash { size_t operator()(...) }). */
export interface IHashFn<K> { HashOf(k: K): L; }
/** A two-argument predicate of the engine's own (a key-equal such as CiEqual). */
export interface IBinFn<K> { Call2(a: K, b: K): boolean; }

/** std::equal_to, for a container whose hasher is the engine's but whose key-equal is the default. */
export class StdEq<K> implements IBinFn<K> {
	Call2(a: K, b: K): boolean { return eqValue(a, b); }
}

function makeFn<T>(m: (() => T) | null | undefined, what: string): T {
	if (m == null) throw new Error("cpp." + what + ": the translator must pass the makers of H and E");
	return m();
}

/** std::unordered_map<K, V, H, E> with the engine's hasher H and key-equal E (made by the makers hm, em): the same
 *  table, hashed by H, so lookups and the iteration order are the C++ ones. */
export class UMapC<K, V, H extends IHashFn<K>, E extends IBinFn<K>> extends UMap<K, V> {
	hm: () => H;
	em: () => E;
	constructor(mk: (() => V) | null, hm: () => H, em: () => E) {
		const h0 = makeFn(hm, "UMapC"), e0 = makeFn(em, "UMapC");
		super((k: K): L => h0.HashOf(k), (a: K, b: K): boolean => e0.Call2(a, b), mk);
		this.hm = hm;
		this.em = em;
	}
	/** UMapC(mk) + the makers of H and E. */
	static new_FuncV<K, V, H extends IHashFn<K>, E extends IBinFn<K>>(mk: (() => V) | null, hm: () => H, em: () => E): UMapC<K, V, H, E> {
		return new UMapC<K, V, H, E>(mk, hm, em);
	}
	/** UMapC(initializer list) + the maker of V and the makers of H and E. */
	static new_PairKVA<K, V, H extends IHashFn<K>, E extends IBinFn<K>>(il: cpp.Pair<K, V>[], mk: (() => V) | null, hm: () => H, em: () => E): UMapC<K, V, H, E> {
		const m = new UMapC<K, V, H, E>(mk, hm, em);
		for (const p of il) m.Insert(p.Clone());
		return m;
	}
	Clone(): UMapC<K, V, H, E> { const m = new UMapC<K, V, H, E>(this.mk, this.hm, this.em); m.CopyFrom(this, pairClone); return m; }
	Assign(o: UMapC<K, V, H, E>): void { super.Assign(o); }
	MoveFrom(o: UMapC<K, V, H, E>): void { super.MoveFrom(o); }
}

/** std::unordered_set<T, H, E> with the engine's hasher and key-equal. */
export class USetC<T, H extends IHashFn<T>, E extends IBinFn<T>> extends USet<T> {
	hm: () => H;
	em: () => E;
	constructor(hm: () => H, em: () => E) {
		const h0 = makeFn(hm, "USetC"), e0 = makeFn(em, "USetC");
		super((k: T): L => h0.HashOf(k), (a: T, b: T): boolean => e0.Call2(a, b));
		this.hm = hm;
		this.em = em;
	}
	static new_TA<T, H extends IHashFn<T>, E extends IBinFn<T>>(il: T[], hm: () => H, em: () => E): USetC<T, H, E> {
		const s = new USetC<T, H, E>(hm, em);
		for (const x of il) s.Insert(x);
		return s;
	}
	Clone(): USetC<T, H, E> { const m = new USetC<T, H, E>(this.hm, this.em); m.CopyFrom(this, elemCopy); return m; }
	Assign(o: USetC<T, H, E>): void { super.Assign(o); }
	MoveFrom(o: USetC<T, H, E>): void { super.MoveFrom(o); }
}

/** std::map: keys kept sorted by the comparator in a list (a red-black tree's order is the sorted order). */
export class Map<K, V> {
	lt: (a: K, b: K) => boolean;
	items: cpp.Pair<K, V>[];
	mk: (() => V) | null;

	/** Map(less, mk): less null is std::less<K>. */
	constructor(less?: ((a: K, b: K) => boolean) | null, mk?: (() => V) | null) {
		this.lt = less != null ? less : lessValue;
		this.items = [];
		this.mk = mk != null ? mk : null;
	}
	static new_FuncKKb_FuncV<K, V>(less: ((a: K, b: K) => boolean) | null, mk: (() => V) | null): Map<K, V> { return new Map<K, V>(less, mk); }
	/** Map(initializer list, less) + the maker of V. */
	static new_PairKVA_FuncKKb<K, V>(il: cpp.Pair<K, V>[], less: ((a: K, b: K) => boolean) | null, mk?: (() => V) | null): Map<K, V> {
		const m = new Map<K, V>(less, mk);
		for (const p of il) m.insert(p.Clone());
		return m;
	}

	Lower(k: K): number {
		const items = this.items, lt = this.lt;
		let lo = 0, hi = items.length;
		while (lo < hi) { const mid = (lo + hi) >>> 1; if (lt(items[mid].first, k)) lo = mid + 1; else hi = mid; }
		return lo;
	}
	FindIdx(k: K): number { const i = this.Lower(k); return (i < this.items.length && !this.lt(k, this.items[i].first)) ? i : -1; }
	MakeV(): V { const mk = this.mk; return mk !== null ? mk() : null; }

	indexPair(k: K): cpp.Pair<K, V> {
		const i = this.Lower(k);
		if (i === this.items.length || this.lt(k, this.items[i].first)) this.items.splice(i, 0, cpp.Pair.new_A_B(keyCopy(k), this.MakeV()));
		return this.items[i];
	}
	/** operator[] read as a value. */
	Index(k: K): V { return this.indexPair(k).second; }
	/** operator[] as a reference. */
	ref_Index(k: K): cpp.Ref<V> { return new SecondRef<V>(this.indexPair(k)); }
	atPair(k: K): cpp.Pair<K, V> { const i = this.FindIdx(k); if (i < 0) outOfRange("map::at"); return this.items[i]; }
	at(k: K): V { return this.atPair(k).second; }
	ref_at(k: K): cpp.Ref<V> { return new SecondRef<V>(this.atPair(k)); }

	res(i: number, added: boolean): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> {
		return cpp.Pair.new_A_B(new MIt<cpp.Pair<K, V>>(null, this.items, i), added);
	}
	insert(p: cpp.Pair<K, V>): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> {
		const i = this.Lower(p.first);
		if (i < this.items.length && !this.lt(p.first, this.items[i].first)) return this.res(i, false);
		this.items.splice(i, 0, cpp.Pair.new_A_B(keyCopy(p.first), p.second));
		return this.res(i, true);
	}
	emplace_K_V(k: K, v: V): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> { return this.insert(cpp.Pair.new_A_B(k, v)); }
	emplace_PairKV(p: cpp.Pair<K, V>): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> { return this.insert(p); }
	try_emplace(k: K, v: V): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> { return this.insert(cpp.Pair.new_A_B(k, v)); }
	insert_or_assign(k: K, v: V): cpp.Pair<MIt<cpp.Pair<K, V>>, boolean> {
		const i = this.FindIdx(k);
		if (i >= 0) { this.items[i].second = v; return this.res(i, false); }
		return this.insert(cpp.Pair.new_A_B(k, v));
	}
	find(k: K): MIt<cpp.Pair<K, V>> { const i = this.FindIdx(k); return new MIt<cpp.Pair<K, V>>(null, this.items, i < 0 ? this.items.length : i); }
	lower_bound(k: K): MIt<cpp.Pair<K, V>> { return new MIt<cpp.Pair<K, V>>(null, this.items, this.Lower(k)); }
	upper_bound(k: K): MIt<cpp.Pair<K, V>> {
		let i = this.Lower(k);
		while (i < this.items.length && !this.lt(k, this.items[i].first)) i++;
		return new MIt<cpp.Pair<K, V>>(null, this.items, i);
	}
	count(k: K): L { return this.FindIdx(k) >= 0 ? 1 : 0; }
	contains(k: K): boolean { return this.FindIdx(k) >= 0; }
	erase_K(k: K): L { const i = this.FindIdx(k); if (i < 0) return 0; this.items.splice(i, 1); return 1; }
	erase_MItPairKV(it: MIt<cpp.Pair<K, V>>): MIt<cpp.Pair<K, V>> { this.items.splice(it.pos, 1); return new MIt<cpp.Pair<K, V>>(null, this.items, it.pos); }
	size(): L { return this.items.length; }
	empty(): boolean { return this.items.length === 0; }
	clear(): void { this.items.length = 0; }
	begin(): MIt<cpp.Pair<K, V>> { return new MIt<cpp.Pair<K, V>>(null, this.items, 0); }
	end(): MIt<cpp.Pair<K, V>> { return new MIt<cpp.Pair<K, V>>(null, this.items, this.items.length); }
	/** The elements in key order (the list itself, as the C# returns it). */
	Items(): Iterable<cpp.Pair<K, V>> { return this.items; }
	Clone(): Map<K, V> {
		const m = new Map<K, V>(this.lt, this.mk);
		for (const p of this.items) m.items.push(p.Clone());
		return m;
	}
	Assign(o: Map<K, V>): void {
		if (this === o) return;
		const l: cpp.Pair<K, V>[] = [];
		for (const p of o.items) l.push(p.Clone());
		this.items = l;
	}
	MoveFrom(o: Map<K, V>): void { if (this === o) return; this.items = o.items; o.items = []; }
}

/** std::set: elements kept sorted by the comparator in a list. */
export class Set<T> {
	lt: (a: T, b: T) => boolean;
	items: T[];

	/** Set(less): less null is std::less<T>. */
	constructor(less?: ((a: T, b: T) => boolean) | null) { this.lt = less != null ? less : lessValue; this.items = []; }
	static new_FuncTTb<T>(less: ((a: T, b: T) => boolean) | null): Set<T> { return new Set<T>(less); }
	/** Set(initializer list, less). */
	static new_TA_FuncTTb<T>(il: T[], less: ((a: T, b: T) => boolean) | null): Set<T> {
		const s = new Set<T>(less);
		for (const x of il) s.insert(x);
		return s;
	}

	Lower(k: T): number {
		const items = this.items, lt = this.lt;
		let lo = 0, hi = items.length;
		while (lo < hi) { const mid = (lo + hi) >>> 1; if (lt(items[mid], k)) lo = mid + 1; else hi = mid; }
		return lo;
	}
	has(i: number, k: T): boolean { return i < this.items.length && !this.lt(k, this.items[i]); }

	insert(x: T): cpp.Pair<MIt<T>, boolean> {
		const i = this.Lower(x);
		if (this.has(i, x)) return cpp.Pair.new_A_B(new MIt<T>(null, this.items, i), false);
		this.items.splice(i, 0, keyCopy(x));
		return cpp.Pair.new_A_B(new MIt<T>(null, this.items, i), true);
	}
	emplace(x: T): cpp.Pair<MIt<T>, boolean> { return this.insert(x); }
	find(k: T): MIt<T> { const i = this.Lower(k); return new MIt<T>(null, this.items, this.has(i, k) ? i : this.items.length); }
	count(k: T): L { return this.has(this.Lower(k), k) ? 1 : 0; }
	contains(k: T): boolean { return this.has(this.Lower(k), k); }
	erase_T(k: T): L { const i = this.Lower(k); if (this.has(i, k)) { this.items.splice(i, 1); return 1; } return 0; }
	erase_MItT(it: MIt<T>): MIt<T> { this.items.splice(it.pos, 1); return new MIt<T>(null, this.items, it.pos); }
	size(): L { return this.items.length; }
	empty(): boolean { return this.items.length === 0; }
	clear(): void { this.items.length = 0; }
	begin(): MIt<T> { return new MIt<T>(null, this.items, 0); }
	end(): MIt<T> { return new MIt<T>(null, this.items, this.items.length); }
	/** The elements in order (the list itself, as the C# returns it). */
	Items(): Iterable<T> { return this.items; }
	Clone(): Set<T> {
		const m = new Set<T>(this.lt);
		for (const x of this.items) m.items.push(elemCopy(x));
		return m;
	}
	Assign(o: Set<T>): void {
		if (this === o) return;
		const l: T[] = [];
		for (const x of o.items) l.push(elemCopy(x));
		this.items = l;
	}
	MoveFrom(o: Set<T>): void { if (this === o) return; this.items = o.items; o.items = []; }
}

/** std::stack over std::deque: push, pop, top. */
export class Stk<T> {
	items: T[] = [];
	push(x: T): void { this.items.push(x); }
	pop(): void { this.items.pop(); }
	top(): T { return this.items[this.items.length - 1]; }
	ref_top(): cpp.Ref<T> { return new cpp.ArrRef<T>(this.items, this.items.length - 1); }
	empty(): boolean { return this.items.length === 0; }
	size(): L { return this.items.length; }
	Clone(): Stk<T> { const s = new Stk<T>(); for (const x of this.items) s.items.push(elemCopy(x)); return s; }
	Assign(o: Stk<T>): void {
		if (this === o) return;
		const a = this.items;
		a.length = 0;
		for (const x of o.items) a.push(elemCopy(x));
	}
	MoveFrom(o: Stk<T>): void {
		if (this === o) return;
		const a = this.items;
		a.length = 0;
		for (const x of o.items) a.push(x);
		o.items.length = 0;
	}
}

/** std::queue over std::deque: first in, first out. */
export class Que<T> {
	items: T[] = [];
	head: number = 0;
	push(x: T): void { this.items.push(x); }
	pop(): void {
		const a = this.items;
		a[this.head] = null;
		this.head++;
		if (this.head > 64 && this.head * 2 > a.length) { a.splice(0, this.head); this.head = 0; }
	}
	front(): T { return this.items[this.head]; }
	ref_front(): cpp.Ref<T> { return new cpp.ArrRef<T>(this.items, this.head); }
	back(): T { return this.items[this.items.length - 1]; }
	ref_back(): cpp.Ref<T> { return new cpp.ArrRef<T>(this.items, this.items.length - 1); }
	empty(): boolean { return this.items.length === this.head; }
	size(): L { return this.items.length - this.head; }
	Clone(): Que<T> {
		const q = new Que<T>();
		for (let i = this.head; i < this.items.length; i++) q.items.push(elemCopy(this.items[i]));
		return q;
	}
	Assign(o: Que<T>): void {
		if (this === o) return;
		const a = this.items;
		a.length = 0;
		this.head = 0;
		for (let i = o.head; i < o.items.length; i++) a.push(elemCopy(o.items[i]));
	}
	MoveFrom(o: Que<T>): void {
		if (this === o) return;
		const a = this.items;
		a.length = 0;
		this.head = 0;
		for (let i = o.head; i < o.items.length; i++) a.push(o.items[i]);
		o.items.length = 0;
		o.head = 0;
	}
}

/** KeyCopy<T>.Of (see keyCopy). */
export class KeyCopy<T> {
	static Of<T>(x: T): T { return keyCopy(x); }
}

/** The element operations the containers and Algo share, decided by value (the C# decides by the static type):
 *  Copy is Elem<T>.Copy, Eq is EqualityComparer<T>.Default.Equals, Less is Less<T>.Fn. */
export class CtElem {
	static Copy<T>(x: T): T { return elemCopy(x); }
	static Eq(a: any, b: any): boolean { return eqValue(a, b); }
	static Less(a: any, b: any): boolean { return lessValue(a, b); }
}
