// containers.js - std::unordered_map / unordered_set with libstdc++'s exact node order (GCC 13 bits/hashtable.h:
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



const JSSet = globalThis.Set;
const TWO32 = 4294967296;
const SAFE = 9007199254740991;
const ULMAX = 18446744073709551615n;

// ---- 64-bit arithmetic on 32-bit halves (the results are left in rh, rl) ----

let rh = 0, rl = 0;

/** (ah:al) * (bh:bl) mod 2^64, exact. */
function mul64(ah, al, bh, bl) {
	const a0 = al & 0xffff, a1 = al >>> 16, b0 = bl & 0xffff, b1 = bl >>> 16;
	const mid = a0 * b1 + a1 * b0;                         // < 2^33
	const lo = a0 * b0 + (mid % 65536) * 65536;            // < 2^33
	const hi = a1 * b1 + Math.floor(mid / 65536) + Math.floor(lo / TWO32);   // high half of al * bl
	rl = lo >>> 0;
	rh = (hi + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0;
}

/** The exact value h * 2^32 + l as a cpp.L (a number when it is a safe integer). */
function hlToL(h, l) {
	return h < 0x200000 ? h * TWO32 + l : (BigInt(h) << 32n) | BigInt(l);
}

/** Splits a long or ulong value (taken mod 2^64) into rh, rl. */
function splitL(x) {
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
function modHL(h, l, n) {
	if (h === 0) return l % n;
	if (n <= 0x200000) return ((h % n) * TWO32 + l) % n;
	const r = ((h % n) * 65536) % n;
	return (((r * 65536) % n) + l) % n;
}

// ---- std::_Hash_bytes (libsupc++/hash_bytes.cc, the 64-bit branch) ----

const MH = 0xc6a4a793, ML = 0x5bd1e995;     // 0xc6a4a7935bd1e995
const SEED = 0xc70f6907;

/** _Hash_bytes(b[off..off+len), seed sh:sl), the result in rh, rl. b holds bytes (0..255). */
function hashBytesHL(b, off, len, sh, sl) {
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

const ids = new WeakMap();
let nextId = 0;
function idOf(o) {
	let v = ids.get(o);
	if (v === undefined) { v = ++nextId; ids.set(o, v); }
	return v;
}

// ---- std::hash, EqualityComparer<T>.Default and std::less by value ----

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);
let latin = new Uint8Array(64);

/** std::hash of a key by its value (C#: StdHash.For<K>()), the code in rh, rl. */
function hashValue(k) {
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

function strEq(a, b) {
	const n = a.n;
	if (b.n !== n) return false;
	const x = a.b, y = b.b;
	for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
	return true;
}

/** char_traits<char>::compare: unsigned bytes, then length (Str.compare). */
function strCompare(a, b) {
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
function eqValue(a, b) {
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
			if (C === cpp.TupN) return b instanceof cpp.TupN && (a).CompareTo(b) === 0;
			if (typeof a.Equals_o === 'function') return a.Equals_o(b);
			return false;
		}
		default: return false;
	}
}

/** std::less: numbers (and enums) with the primitive a < b, a Str as std::string compares, a Pair first then
 *  second, a value with CompareTo (TupN, FsPath) by it, false before true, null first; objects with no order of
 *  their own (std::set<const Column*>, which C++ orders by address) by a fixed identity order. */
function lessValue(a, b) {
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

let runtimeCtors = null;
/** Whether x is an object of a runtime class (one the cpp module exports; C#: namespace Cpp). */
function isRuntimeObj(x) {
	if (runtimeCtors === null) {
		const s = new JSSet();
		for (const v of Object.values(cpp)) if (typeof v === 'function') s.add(v);
		runtimeCtors = s;
	}
	return runtimeCtors.has(x.constructor);
}

/** Elem<T>.Copy: an object with Clone (ICopy) is cloned, an array copied deeply, any other value is itself. */
function elemCopy(x) {
	if (x === null || typeof x !== 'object') return x;
	if (Array.isArray(x)) return arrDeep(x);
	if (ArrayBuffer.isView(x)) return (x).slice();
	const c = (x).Clone;
	return typeof c === 'function' ? c.call(x) : x;
}

function arrDeep(a) {
	const b = a.slice();
	for (let i = 0; i < a.length; i++) { const v = a[i]; if (v != null && typeof v === 'object') b[i] = elemCopy(v); }
	return b;
}

/** KeyCopy<T>.Of: a key that is a runtime value (Str, Pair, Vec, TupN, ...) is the container's own copy; an engine
 *  object (a pointer in C++) is stored as it is. */
function keyCopy(x) {
	if (x !== null && typeof x === 'object' && isRuntimeObj(x)) {
		const c = (x).Clone;
		if (typeof c === 'function') return c.call(x);
	}
	return x;
}

function pairClone(p) { return p.Clone(); }
function same(x) { return x; }
function pairFirst(p) { return p.first; }

function outOfRange(msg) {
	const O = cpp.OutOfRange;
	if (typeof O.new_str === 'function') throw O.new_str(msg);
	throw O.new_Str(cpp.Str.new_CPtr(cpp.R.Lit(msg)));
}

/** A reference to a pair's mapped value (the ref V the C# operator[] and at() return). */
class SecondRef {
	p;
	constructor(p) { this.p = p; }
	get() { return this.p.second; }
	set(v) { this.p.second = v; }
}

function addU(a, b) {
	if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= SAFE) return r; }
	const r = BigInt.asUintN(64, BigInt(a) + BigInt(b));
	return r <= BigInt(SAFE) ? Number(r) : r;
}

function mulU(a, b) {
	if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= SAFE) return r; }
	const r = BigInt.asUintN(64, BigInt(a) * BigInt(b));
	return r <= BigInt(SAFE) ? Number(r) : r;
}

/** (ulong) of a non-negative integral double. */
function d2ul(x) {
	return x <= SAFE ? x : BigInt.asUintN(64, BigInt(x));
}

// ---- the public classes ----

export class StdHash {
	/** libstdc++'s std::_Hash_bytes (libsupc++/hash_bytes.cc, the 64-bit branch). */
	static HashBytes(b, off, len, seed) {
		splitL(seed);
		hashBytesHL(b, off, len, rh, rl);
		return hlToL(rh, rl);
	}
	static Of_Str(s) { hashBytesHL(s.b, 0, s.n, 0, SEED); return hlToL(rh, rl); }
	static Of_i(v) { splitL(v); return hlToL(rh, rl); }
	static Of_l(v) { splitL(v); return hlToL(rh, rl); }
	static Of_u(v) { return v; }
	static Of_ul(v) { return v; }
	/** StdHash.For<K>(): std::hash<K>, by the key's value (see the header). */
	static For() { return stdHashOf; }
}

function stdHashOf(k) { hashValue(k); return hlToL(rh, rl); }

export class Hash {
	static Of(x) { return stdHashOf(x); }
	op_Call(x) { return stdHashOf(x); }
}

export class EqualTo {
	op_Call(a, b) { return eqValue(a, b); }
}

export class Less {
	/** Less<T>.Fn, one function for every T (the engine passes it where the C# passes Less<double>.Fn, ...). */
	static Fn = lessValue;
	op_Call(a, b) { return lessValue(a, b); }
}

const FAST_BKT = [2, 2, 2, 3, 5, 5, 7, 7, 11, 11, 11, 11, 13, 13];

/** The prime rehash policy (libstdc++ src/c++11/hashtable_c++0x.cc and hashtable-aux.cc). */
export class RehashPolicy {
	MaxLoad = 1.0;
	NextResize = 0;

	NextBkt(n) {
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

	BktForElements(n) { return d2ul(Math.ceil(Number(n) / this.MaxLoad)); }

	/** _M_need_rehash: the new bucket count, or 0 for no rehash (C#: the pair (true, n) / (false, 0)). */
	NeedRehash(nBkt, nElt, nIns) {
		const tot = addU(nElt, nIns);
		if (tot > this.NextResize) {
			const floor0 = this.NextResize != 0 ? 0 : 11;
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
export class HNode {
	next = null;
	val = null;
	h = 0;
	l = 0;
	/** The cached hash code (C#: ulong code). */
	get code() { return hlToL(this.h, this.l); }
}

function newBuckets(n) {
	const a = new Array(n);
	for (let i = 0; i < n; i++) a[i] = null;
	return a;
}

/** libstdc++'s _Hashtable for unique keys. E is the stored element (Pair<K, V> or K). */
export class HashTable {
	key;
	/** The hasher (Func<K, ulong>); null: std::hash<K>, by the key's value. */
	hash;
	eq;
	buckets;
	beforeBegin;
	nelem;
	pol;

	constructor(key, hash, eq) {
		this.key = key;
		this.hash = hash != null ? hash : null;
		this.eq = eq != null ? eq : eqValue;
		this.buckets = newBuckets(1);
		this.beforeBegin = new HNode();
		this.nelem = 0;
		this.pol = new RehashPolicy();
	}

	/** The hash code of k, into rh, rl. */
	codeOf(k) {
		const h = this.hash;
		if (h === null) hashValue(k); else splitL(h(k));
	}

	/** The node holding k (whose code is h:l), or null. */
	findNode(k, h, l) {
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

	Find(k) {
		this.codeOf(k);
		return this.findNode(k, rh, rl);
	}

	/** Adds e, whose key is absent and has the code h:l: the rehash check, then the node at its bucket's front. */
	link(e, h, l) {
		const n = this.pol.NeedRehash(this.buckets.length, this.nelem, 1);
		if (n != 0) this.Rehash(n);
		const node = new HNode();
		node.val = e;
		node.h = h;
		node.l = l;
		this.insertBucketBegin(modHL(h, l, this.buckets.length), node);
		this.nelem++;
		return node;
	}

	/** Inserts e if its key is absent; returns the node holding the key. */
	Insert(e) {
		const k = this.key(e);
		this.codeOf(k);
		const h = rh, l = rl;
		const found = this.findNode(k, h, l);
		if (found !== null) return found;
		return this.link(e, h, l);
	}

	insertBucketBegin(b, node) {
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
	Rehash(n) {
		const m = Number(n);
		const nb = newBuckets(m);
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

	EraseKey(k) {
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

	eraseNode(b, prev, n) {
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

	EraseAt(n) {
		const b = modHL(n.h, n.l, this.buckets.length);
		let prev = this.buckets[b];
		while (prev.next !== n) prev = prev.next;
		this.eraseNode(b, prev, n);
	}

	size() { return this.nelem; }
	empty() { return this.nelem === 0; }
	/** Keeps the bucket count, as libstdc++'s clear does. */
	clear() { this.buckets = newBuckets(this.buckets.length); this.beforeBegin.next = null; this.nelem = 0; }
	bucket_count() { return this.buckets.length; }

	reserve(n) { this.rehash(this.pol.BktForElements(n)); }
	/** _M_rehash_policy._M_next_bkt(max(n, bkt_for_elements(size + 1))), only if it differs. */
	rehash(n) {
		const m = this.pol.BktForElements(this.nelem + 1);
		const want = this.pol.NextBkt(n > m ? n : m);
		if (want != this.buckets.length) this.Rehash(want);
	}

	/** The elements in node order; like the C# iterator, each step reads the next link only when the loop asks for
	 *  the next element. */
	*Items() {
		for (let p = this.beforeBegin.next; p !== null; p = p.next) yield p.val;
	}

	begin() { return new MIt(this.beforeBegin.next, null, 0); }
	end() { return MIt.ZERO; }
	find(k) { return new MIt(this.Find(k), null, 0); }
	count_(k) { return this.Find(k) !== null ? 1 : 0; }
	count(k) { return this.Find(k) !== null ? 1 : 0; }
	contains(k) { return this.Find(k) !== null; }
	erase_K(k) { return this.EraseKey(k) ? 1 : 0; }
	erase_MItE(it) { const nx = it.node.next; this.EraseAt(it.node); return new MIt(nx, null, 0); }

	/** _M_assign: the same bucket count, the same node order, each element copied by copy. */
	CopyFrom(o, copy) {
		const bs = newBuckets(o.buckets.length), nb = bs.length;
		this.buckets = bs;
		this.beforeBegin.next = null;
		this.nelem = 0;
		this.pol.NextResize = o.pol.NextResize;
		let prev = this.beforeBegin;
		for (let p = o.beforeBegin.next; p !== null; p = p.next) {
			const n = new HNode();
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
export class MIt {
	static ZERO = new MIt(null, null, 0);
	node;
	list;
	pos;
	constructor(node, list, pos) { this.node = node; this.list = list; this.pos = pos; }
	static new_HNodeE(n) { return new MIt(n, null, 0); }
	static new_ListE_i(l, p) { return new MIt(null, l, p); }
	/** A value: copying it is the copy. */
	Clone() { return this; }
	get_Deref() { return this.list !== null ? this.list[this.pos] : this.node.val; }
	static op_Increment(x) { return x.list !== null ? new MIt(null, x.list, x.pos + 1) : new MIt(x.node.next, null, 0); }
	static op_Decrement(x) { return new MIt(null, x.list, x.pos - 1); }
	/** A list position compares by position (a hashed container's iterator counts as no position); two nodes by
	 *  identity. */
	static op_Eq(a, b) {
		if (a.list !== null || b.list !== null) return posOf(a) === posOf(b);
		return a.node === b.node;
	}
	static op_Ne(a, b) { return !MIt.op_Eq(a, b); }
	Equals_MItE(o) { return MIt.op_Eq(this, o); }
	Equals_o(o) { return o instanceof MIt && MIt.op_Eq(this, o); }
	GetHashCode() { return this.pos; }
}

function posOf(x) { return x.list !== null ? x.pos : 2147483647; }

function res(n, added) {
	return cpp.Pair.new_A_B(new MIt(n, null, 0), added);
}

export class UMap extends HashTable {
	/** How to make a mapped value (the translator's maker; C#: an explicit maker or Elem<V>.Make). */
	mk;

	/** UMap(h, eq, mk): h null is std::hash<K>, eq null std::equal_to<K>. */
	constructor(h, eq, mk) {
		super(pairFirst, h, eq);
		this.mk = mk != null ? mk : null;
	}
	static new_FuncKul_FuncKKb_FuncV(h, eq, mk) {
		return new UMap(h, eq, mk);
	}
	/** UMap(initializer list, h, eq) + the maker of V: each pair copied in, a repeated key keeping the first. */
	static new_PairKVA_FuncKul_FuncKKb(il, h, eq, mk) {
		const m = new UMap(h, eq, mk);
		for (const p of il) m.Insert(p.Clone());
		return m;
	}

	MakeV() { const mk = this.mk; return mk !== null ? mk() : null; }

	/** operator[]: the node for k, inserted with a made value if absent (the map owns a copy of the key). */
	indexNode(k) {
		this.codeOf(k);
		const h = rh, l = rl;
		let f = this.findNode(k, h, l);
		if (f === null) f = this.link(cpp.Pair.new_A_B(keyCopy(k), this.MakeV()), h, l);
		return f;
	}
	/** operator[] read as a value. */
	Index(k) { return this.indexNode(k).val.second; }
	/** operator[] as a reference. */
	ref_Index(k) { return new SecondRef(this.indexNode(k).val); }

	atNode(k) {
		const f = this.Find(k);
		if (f === null) outOfRange("_Map_base::at");
		return f;
	}
	at(k) { return this.atNode(k).val.second; }
	ref_at(k) { return new SecondRef(this.atNode(k).val); }

	/** insert(k, v) if k is absent, the key copied in. */
	insertKV(k, v) {
		this.codeOf(k);
		const h = rh, l = rl;
		const f = this.findNode(k, h, l);
		if (f !== null) return res(f, false);
		return res(this.link(cpp.Pair.new_A_B(keyCopy(k), v), h, l), true);
	}

	insert(p) { return this.insertKV(p.first, p.second); }
	emplace_K_V(k, v) { return this.insertKV(k, v); }
	emplace_PairKV(p) { return this.insertKV(p.first, p.second); }
	try_emplace_K_V(k, v) { return this.insertKV(k, v); }
	try_emplace_K(k) { return this.insertKV(k, this.MakeV()); }
	insert_or_assign(k, v) {
		const f = this.Find(k);
		if (f !== null) { f.val.second = v; return res(f, false); }
		return this.insertKV(k, v);
	}

	Clone() { const m = new UMap(this.hash, this.eq, this.mk); m.CopyFrom(this, pairClone); return m; }
	Assign(o) { if (this !== o) this.CopyFrom(o, pairClone); }
	MoveFrom(o) { if (this !== o) { this.CopyFrom(o, same); o.clear(); } }
}

export class USet extends HashTable {
	/** USet(h, eq): h null is std::hash<T>, eq null std::equal_to<T>. */
	constructor(h, eq) { super(same, h, eq); }
	static new_FuncTul_FuncTTb(h, eq) { return new USet(h, eq); }
	/** USet(initializer list, h, eq). */
	static new_TA_FuncTul_FuncTTb(il, h, eq) {
		const s = new USet(h, eq);
		for (const x of il) s.Insert(x);
		return s;
	}

	insert(x) {
		this.codeOf(x);
		const h = rh, l = rl;
		const f = this.findNode(x, h, l);
		if (f !== null) return res(f, false);
		return res(this.link(keyCopy(x), h, l), true);
	}
	emplace(x) { return this.insert(x); }

	Clone() { const m = new USet(this.hash, this.eq); m.CopyFrom(this, elemCopy); return m; }
	Assign(o) { if (this !== o) this.CopyFrom(o, elemCopy); }
	MoveFrom(o) { if (this !== o) { this.CopyFrom(o, same); o.clear(); } }
}

/** A hasher of the engine's own (struct CiHash { size_t operator()(...) }). */

/** A two-argument predicate of the engine's own (a key-equal such as CiEqual). */


/** std::equal_to, for a container whose hasher is the engine's but whose key-equal is the default. */
export class StdEq {
	Call2(a, b) { return eqValue(a, b); }
}

function makeFn(m, what) {
	if (m == null) throw new Error("cpp." + what + ": the translator must pass the makers of H and E");
	return m();
}

/** std::unordered_map<K, V, H, E> with the engine's hasher H and key-equal E (made by the makers hm, em): the same
 *  table, hashed by H, so lookups and the iteration order are the C++ ones. */
export class UMapC extends UMap {
	hm;
	em;
	constructor(mk, hm, em) {
		const h0 = makeFn(hm, "UMapC"), e0 = makeFn(em, "UMapC");
		super((k) => h0.HashOf(k), (a, b) => e0.Call2(a, b), mk);
		this.hm = hm;
		this.em = em;
	}
	/** UMapC(mk) + the makers of H and E. */
	static new_FuncV(mk, hm, em) {
		return new UMapC(mk, hm, em);
	}
	/** UMapC(initializer list) + the maker of V and the makers of H and E. */
	static new_PairKVA(il, mk, hm, em) {
		const m = new UMapC(mk, hm, em);
		for (const p of il) m.Insert(p.Clone());
		return m;
	}
	Clone() { const m = new UMapC(this.mk, this.hm, this.em); m.CopyFrom(this, pairClone); return m; }
	Assign(o) { super.Assign(o); }
	MoveFrom(o) { super.MoveFrom(o); }
}

/** std::unordered_set<T, H, E> with the engine's hasher and key-equal. */
export class USetC extends USet {
	hm;
	em;
	constructor(hm, em) {
		const h0 = makeFn(hm, "USetC"), e0 = makeFn(em, "USetC");
		super((k) => h0.HashOf(k), (a, b) => e0.Call2(a, b));
		this.hm = hm;
		this.em = em;
	}
	static new_TA(il, hm, em) {
		const s = new USetC(hm, em);
		for (const x of il) s.Insert(x);
		return s;
	}
	Clone() { const m = new USetC(this.hm, this.em); m.CopyFrom(this, elemCopy); return m; }
	Assign(o) { super.Assign(o); }
	MoveFrom(o) { super.MoveFrom(o); }
}

/** std::map: keys kept sorted by the comparator in a list (a red-black tree's order is the sorted order). */
export class Map {
	lt;
	items;
	mk;

	/** Map(less, mk): less null is std::less<K>. */
	constructor(less, mk) {
		this.lt = less != null ? less : lessValue;
		this.items = [];
		this.mk = mk != null ? mk : null;
	}
	static new_FuncKKb_FuncV(less, mk) { return new Map(less, mk); }
	/** Map(initializer list, less) + the maker of V. */
	static new_PairKVA_FuncKKb(il, less, mk) {
		const m = new Map(less, mk);
		for (const p of il) m.insert(p.Clone());
		return m;
	}

	Lower(k) {
		const items = this.items, lt = this.lt;
		let lo = 0, hi = items.length;
		while (lo < hi) { const mid = (lo + hi) >>> 1; if (lt(items[mid].first, k)) lo = mid + 1; else hi = mid; }
		return lo;
	}
	FindIdx(k) { const i = this.Lower(k); return (i < this.items.length && !this.lt(k, this.items[i].first)) ? i : -1; }
	MakeV() { const mk = this.mk; return mk !== null ? mk() : null; }

	indexPair(k) {
		const i = this.Lower(k);
		if (i === this.items.length || this.lt(k, this.items[i].first)) this.items.splice(i, 0, cpp.Pair.new_A_B(keyCopy(k), this.MakeV()));
		return this.items[i];
	}
	/** operator[] read as a value. */
	Index(k) { return this.indexPair(k).second; }
	/** operator[] as a reference. */
	ref_Index(k) { return new SecondRef(this.indexPair(k)); }
	atPair(k) { const i = this.FindIdx(k); if (i < 0) outOfRange("map::at"); return this.items[i]; }
	at(k) { return this.atPair(k).second; }
	ref_at(k) { return new SecondRef(this.atPair(k)); }

	res(i, added) {
		return cpp.Pair.new_A_B(new MIt(null, this.items, i), added);
	}
	insert(p) {
		const i = this.Lower(p.first);
		if (i < this.items.length && !this.lt(p.first, this.items[i].first)) return this.res(i, false);
		this.items.splice(i, 0, cpp.Pair.new_A_B(keyCopy(p.first), p.second));
		return this.res(i, true);
	}
	emplace_K_V(k, v) { return this.insert(cpp.Pair.new_A_B(k, v)); }
	emplace_PairKV(p) { return this.insert(p); }
	try_emplace(k, v) { return this.insert(cpp.Pair.new_A_B(k, v)); }
	insert_or_assign(k, v) {
		const i = this.FindIdx(k);
		if (i >= 0) { this.items[i].second = v; return this.res(i, false); }
		return this.insert(cpp.Pair.new_A_B(k, v));
	}
	find(k) { const i = this.FindIdx(k); return new MIt(null, this.items, i < 0 ? this.items.length : i); }
	lower_bound(k) { return new MIt(null, this.items, this.Lower(k)); }
	upper_bound(k) {
		let i = this.Lower(k);
		while (i < this.items.length && !this.lt(k, this.items[i].first)) i++;
		return new MIt(null, this.items, i);
	}
	count(k) { return this.FindIdx(k) >= 0 ? 1 : 0; }
	contains(k) { return this.FindIdx(k) >= 0; }
	erase_K(k) { const i = this.FindIdx(k); if (i < 0) return 0; this.items.splice(i, 1); return 1; }
	erase_MItPairKV(it) { this.items.splice(it.pos, 1); return new MIt(null, this.items, it.pos); }
	size() { return this.items.length; }
	empty() { return this.items.length === 0; }
	clear() { this.items.length = 0; }
	begin() { return new MIt(null, this.items, 0); }
	end() { return new MIt(null, this.items, this.items.length); }
	/** The elements in key order (the list itself, as the C# returns it). */
	Items() { return this.items; }
	Clone() {
		const m = new Map(this.lt, this.mk);
		for (const p of this.items) m.items.push(p.Clone());
		return m;
	}
	Assign(o) {
		if (this === o) return;
		const l = [];
		for (const p of o.items) l.push(p.Clone());
		this.items = l;
	}
	MoveFrom(o) { if (this === o) return; this.items = o.items; o.items = []; }
}

/** std::set: elements kept sorted by the comparator in a list. */
export class Set {
	lt;
	items;

	/** Set(less): less null is std::less<T>. */
	constructor(less) { this.lt = less != null ? less : lessValue; this.items = []; }
	static new_FuncTTb(less) { return new Set(less); }
	/** Set(initializer list, less). */
	static new_TA_FuncTTb(il, less) {
		const s = new Set(less);
		for (const x of il) s.insert(x);
		return s;
	}

	Lower(k) {
		const items = this.items, lt = this.lt;
		let lo = 0, hi = items.length;
		while (lo < hi) { const mid = (lo + hi) >>> 1; if (lt(items[mid], k)) lo = mid + 1; else hi = mid; }
		return lo;
	}
	has(i, k) { return i < this.items.length && !this.lt(k, this.items[i]); }

	insert(x) {
		const i = this.Lower(x);
		if (this.has(i, x)) return cpp.Pair.new_A_B(new MIt(null, this.items, i), false);
		this.items.splice(i, 0, keyCopy(x));
		return cpp.Pair.new_A_B(new MIt(null, this.items, i), true);
	}
	emplace(x) { return this.insert(x); }
	find(k) { const i = this.Lower(k); return new MIt(null, this.items, this.has(i, k) ? i : this.items.length); }
	count(k) { return this.has(this.Lower(k), k) ? 1 : 0; }
	contains(k) { return this.has(this.Lower(k), k); }
	erase_T(k) { const i = this.Lower(k); if (this.has(i, k)) { this.items.splice(i, 1); return 1; } return 0; }
	erase_MItT(it) { this.items.splice(it.pos, 1); return new MIt(null, this.items, it.pos); }
	size() { return this.items.length; }
	empty() { return this.items.length === 0; }
	clear() { this.items.length = 0; }
	begin() { return new MIt(null, this.items, 0); }
	end() { return new MIt(null, this.items, this.items.length); }
	/** The elements in order (the list itself, as the C# returns it). */
	Items() { return this.items; }
	Clone() {
		const m = new Set(this.lt);
		for (const x of this.items) m.items.push(elemCopy(x));
		return m;
	}
	Assign(o) {
		if (this === o) return;
		const l = [];
		for (const x of o.items) l.push(elemCopy(x));
		this.items = l;
	}
	MoveFrom(o) { if (this === o) return; this.items = o.items; o.items = []; }
}

/** std::stack over std::deque: push, pop, top. */
export class Stk {
	items = [];
	push(x) { this.items.push(x); }
	pop() { this.items.pop(); }
	top() { return this.items[this.items.length - 1]; }
	ref_top() { return new cpp.ArrRef(this.items, this.items.length - 1); }
	empty() { return this.items.length === 0; }
	size() { return this.items.length; }
	Clone() { const s = new Stk(); for (const x of this.items) s.items.push(elemCopy(x)); return s; }
	Assign(o) {
		if (this === o) return;
		const a = this.items;
		a.length = 0;
		for (const x of o.items) a.push(elemCopy(x));
	}
	MoveFrom(o) {
		if (this === o) return;
		const a = this.items;
		a.length = 0;
		for (const x of o.items) a.push(x);
		o.items.length = 0;
	}
}

/** std::queue over std::deque: first in, first out. */
export class Que {
	items = [];
	head = 0;
	push(x) { this.items.push(x); }
	pop() {
		const a = this.items;
		a[this.head] = null;
		this.head++;
		if (this.head > 64 && this.head * 2 > a.length) { a.splice(0, this.head); this.head = 0; }
	}
	front() { return this.items[this.head]; }
	ref_front() { return new cpp.ArrRef(this.items, this.head); }
	back() { return this.items[this.items.length - 1]; }
	ref_back() { return new cpp.ArrRef(this.items, this.items.length - 1); }
	empty() { return this.items.length === this.head; }
	size() { return this.items.length - this.head; }
	Clone() {
		const q = new Que();
		for (let i = this.head; i < this.items.length; i++) q.items.push(elemCopy(this.items[i]));
		return q;
	}
	Assign(o) {
		if (this === o) return;
		const a = this.items;
		a.length = 0;
		this.head = 0;
		for (let i = o.head; i < o.items.length; i++) a.push(elemCopy(o.items[i]));
	}
	MoveFrom(o) {
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
export class KeyCopy {
	static Of(x) { return keyCopy(x); }
}

/** The element operations the containers and Algo share, decided by value (the C# decides by the static type):
 *  Copy is Elem<T>.Copy, Eq is EqualityComparer<T>.Default.Equals, Less is Less<T>.Fn. */
export class CtElem {
	static Copy(x) { return elemCopy(x); }
	static Eq(a, b) { return eqValue(a, b); }
	static Less(a, b) { return lessValue(a, b); }
}
// (ts/src/cpp/containers.ts without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)
