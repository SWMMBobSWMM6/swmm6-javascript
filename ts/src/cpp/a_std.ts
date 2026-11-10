// a_std.ts - part A of the TypeScript runtime (package cpp): the C++ standard library pieces of cs/runtime/Std.cs
// (Elem copy semantics, std::vector as Vec, its iterators Iter and RevIter, raw pointers Ptr, std::span as CSpan,
// std::pair, std::optional, the array helpers Arr, std::min/max/clamp as M, the C++ exception classes) and of
// cs/runtime/Misc.cs (Box, Dtor, Defer, Mv).
//
// Generics are erased, so where the C# runtime asks the type T (Elem<T>.IsClass, Elem<T>.Make) this one asks the value
// or is handed a maker (ts/RUNTIME_HELPERS.md, "Extra arguments"): copying an element calls its Clone() when it has one
// (an engine class, a Str, a container: every ICopy), copies an array deeply, and keeps any other value (a number, a
// bigint long, a runtime struct, which is immutable here). Runtime structs (Iter, RevIter, Ptr, CSpan) are immutable
// objects; their default value is the static ZERO.
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

import * as cpp from './index.js';
import type { L } from './a_long.js';
import { ArrRef, FieldRef, type Ref, type RefAt } from './a_ref.js';
import { Str, CPtr } from './a_str.js';

/** C#'s ICopy<T>: Clone is the copy constructor, Assign the copy assignment. */
export interface ICopy<T> {
	Clone(): T;
	Assign(other: T): void;
}

/** A long or ulong offset or count as a number ((long)x of a ulong: x - 2^64 above 2^63). */
function lng(k: L): number { return typeof k === 'number' ? k : Number(BigInt.asIntN(64, k)); }

// ---------------------------------------------------------------- Elem: copying, comparing, defaults
/** Elem<T>.Copy: C++ copy construction of an element. */
function copy<T>(x: T): T {
	if (x === null || typeof x !== 'object') return x;
	if (Array.isArray(x)) return deep(x) as any;
	const c = (x as any).Clone;
	if (typeof c === 'function') return c.call(x);
	if (ArrayBuffer.isView(x)) return (x as any).slice();
	return x;
}
/** ArrCopy.Deep: a C array copied with its object (T a[n][m], or an array of classes): every row and element. */
function deep(a: any[]): any[] {
	const b = a.slice();
	for (let i = 0; i < b.length; i++) { const v = b[i]; if (v !== null && typeof v === 'object') b[i] = copy(v); }
	return b;
}
/** Whether copying x means more than copying the reference (an ICopy or an array). */
function needsCopy(x: any): boolean {
	return x !== null && typeof x === 'object' && (Array.isArray(x) || ArrayBuffer.isView(x) || typeof x.Clone === 'function');
}
/** EqualityComparer<T>.Default.Equals: numbers by value with NaN equal to NaN (double.Equals), a Str or a runtime
 *  struct by value (its Equals_o), everything else by identity (no engine class overrides Equals). */
function eq(a: any, b: any): boolean {
	if (a === b) return true;
	switch (typeof a) {
		case 'number': return a !== a && b !== b;
		case 'bigint': return a == b;
		case 'object':
			if (a === null || b == null) return a == b;
			if (typeof a.Equals_o === 'function') return a.Equals_o(b);
			return false;
		case 'undefined': return b == null;
	}
	return false;
}
/** default(T) for an element like x: 0 for a number or a long, false for a bool, a runtime struct's ZERO, null for
 *  any other object; undefined when x says nothing (a hole). */
function zero(x: any): any {
	switch (typeof x) {
		case 'number': case 'bigint': return 0;
		case 'boolean': return false;
		case 'undefined': return undefined;
		case 'object':
			if (x !== null) { const c = x.constructor, z = c == null ? undefined : c.ZERO; if (z !== undefined && z instanceof c) return z; }
			return null;
	}
	return null;
}

/** Whether a maker's value is plain: a number, a bool, a string, null or a runtime struct's ZERO. A maker of such a
 *  value (the translator's () => 0, () => false, () => cpp.X.ZERO, () => null) returns the same value every time and
 *  does nothing else, so it need not be called once per element. */
function plain(v: any): boolean { return v === null || (typeof v !== 'object' && typeof v !== 'function') || zero(v) === v; }
/** Push count elements made by f onto a, in order: f called once if it makes a plain value, once per element if not. */
function pushMade<T>(a: T[], f: () => T, count: number): void {
	if (count <= 0) return;
	const v0 = f();
	a.push(v0);
	if (plain(v0)) for (let i = 1; i < count; i++) a.push(v0);
	else for (let i = 1; i < count; i++) a.push(f());
}

/** How the containers copy, compare and default their elements (C# Cpp.Elem<T>, EqualityComparer<T>.Default). */
export class Elem {
	static Copy<T>(x: T): T { return copy(x); }
	static NeedsCopy(x: any): boolean { return needsCopy(x); }
	static Eq(a: any, b: any): boolean { return eq(a, b); }
	/** default(T) as an element like x gives it (0, false, a struct's ZERO, null). */
	static Zero(x: any): any { return zero(x); }
}
/** C# Cpp.ArrCopy. */
export class ArrCopy {
	static Deep(x: any): any { return Array.isArray(x) ? deep(x) : copy(x); }
}

// ---------------------------------------------------------------- std::vector
/** std::vector<T>: the storage a (a JavaScript array whose length is the capacity, exactly as the C# array's) and
 *  the size n, read and written directly by the engine (v.a[i], v.n). Element copies follow C++: copying the vector
 *  or inserting from a range copies each element; push_back stores what it is given (the translator copies a named
 *  argument). Growth is libstdc++'s: a full vector grows to size + max(size, 1), into a new array (an iterator or a
 *  Ref made before keeps the old one, as in C#). The slots past n hold default(T). */
export class Vec<T> implements ICopy<Vec<T>> {
	a: T[];
	n: number;
	/** C#'s mk: how to make a new element when T alone cannot say (a std::array element), from Vec(Func<T> mk). */
	mk: (() => T) | null;
	/** The element maker the translator passes (C#'s Elem<T>.Make: new T() or default(T)). */
	em: (() => T) | null;

	/** new Vec<T>(): empty (C#'s Vec()); em is the element maker. */
	constructor(em?: () => T) { this.a = []; this.n = 0; this.mk = null; this.em = em === undefined ? null : em; }

	/** Vec(Func<T> mk). */
	static new_FuncT<T>(mk: () => T): Vec<T> { const v = new Vec<T>(); v.mk = mk; return v; }
	/** Vec(ulong count, Func<T> mk): count elements made by mk. */
	static new_ul_FuncT<T>(count: L, mk: () => T): Vec<T> {
		const v = new Vec<T>(); v.mk = mk;
		const n = Number(count), a: T[] = [];
		pushMade(a, mk, n);
		v.a = a; v.n = n;
		return v;
	}
	/** Vec(ulong count): count default elements (made by em). */
	static new_ul<T>(count: L, em?: () => T): Vec<T> {
		const v = new Vec<T>(em);
		const n = Number(count), a: T[] = [];
		if (v.em !== null) pushMade(a, v.em, n);
		else for (let i = 0; i < n; i++) a.push(0 as any);
		v.a = a; v.n = n;
		return v;
	}
	/** Vec(ulong count, T v): count copies of x. */
	static new_ul_T<T>(count: L, x: T, em?: () => T): Vec<T> {
		const v = new Vec<T>(em);
		const n = Number(count), a: T[] = [];
		for (let i = 0; i < n; i++) a.push(copy(x));
		v.a = a; v.n = n;
		return v;
	}
	/** Vec(T[] init): copies of the initializer's elements. */
	static new_TA<T>(init: T[], em?: () => T): Vec<T> {
		const v = new Vec<T>(em);
		const n = init.length, a: T[] = [];
		for (let i = 0; i < n; i++) a.push(copy(init[i]));
		v.a = a; v.n = n;
		return v;
	}
	/** A vector over arr itself (no copy). */
	static Adopt<T>(arr: T[], em?: () => T): Vec<T> { const v = new Vec<T>(em); v.a = arr; v.n = arr.length; return v; }

	/** ~vector: each element in order, first to last (libstdc++ _Destroy). */
	DestroyElems(): void { for (let i = 0; i < this.n; i++) Dtor.Run(this.a[i]); }

	/** default(T) into slots from..to-1 (C#'s Array.Clear). */
	private clear_(from: number, to: number): void {
		if (from >= to) return;
		const z = zero(this.a[from]);
		if (z !== undefined) this.a.fill(z, from, to);
	}
	/** A new array of capacity cap holding the current one's slots; the new slots default(T) like sample. */
	private realloc_(cap: number, sample: any): void {
		const na = this.a.slice();
		let z = zero(sample);
		if (z === undefined) z = 0;
		for (let i = na.length; i < cap; i++) na.push(z);
		this.a = na;
	}
	private grow_(need: number, hint: any): void {
		const len = this.a.length;
		if (need <= len) return;
		const n = this.n;
		this.realloc_(Math.max(need, n + Math.max(n, 1)), len > 0 ? this.a[0] : hint);
	}

	// ---- indexers (the engine indexes v.a directly; these are the C# indexer's property names)
	get_Item_ul(i: L): T { return this.a[Number(i)]; }
	get_Item_l(i: L): T { return this.a[Number(i)]; }
	get_Item_i(i: number): T { return this.a[i]; }
	ref_Item_ul(i: L): Ref<T> { return new ArrRef<T>(this.a, Number(i)); }
	ref_Item_l(i: L): Ref<T> { return new ArrRef<T>(this.a, Number(i)); }
	ref_Item_i(i: number): Ref<T> { return new ArrRef<T>(this.a, i); }

	size(): L { return this.n; }
	empty(): boolean { return this.n === 0; }
	capacity(): L { return this.a.length; }
	private check_(i: L): void {
		if (i >= this.n) throw OutOfRange.new_str("vector::_M_range_check: __n (which is " + i + ") >= this->size() (which is " + this.n + ")");
	}
	at(i: L): T { this.check_(i); return this.a[Number(i)]; }
	ref_at(i: L): Ref<T> { this.check_(i); return new ArrRef<T>(this.a, Number(i)); }
	front(): T { return this.a[0]; }
	ref_front(): Ref<T> { return new ArrRef<T>(this.a, 0); }
	back(): T { return this.a[this.n - 1]; }
	ref_back(): Ref<T> { return new ArrRef<T>(this.a, this.n - 1); }
	/** libstdc++'s data() is the start of the storage, which is nullptr until the vector first allocates (capacity
	 *  0); the engine tests it (C# Cpp.Vec.data). */
	data(): Ptr<T> { return this.a.length === 0 ? Ptr.ZERO : new Ptr<T>(this.a, 0, null, null); }

	reserve(c: L): void { const m = Number(c); if (m > this.a.length) this.realloc_(m, this.a.length > 0 ? this.a[0] : undefined); }
	push_back(v: T): void {
		if (this.n >= this.a.length) this.grow_(this.n + 1, v);
		this.a[this.n++] = v;
	}
	emplace_back(v: T): T { this.push_back(v); return v; }
	ref_emplace_back(v: T): Ref<T> { this.push_back(v); return new ArrRef<T>(this.a, this.n - 1); }
	pop_back(): void { const a = this.a; this.n--; a[this.n] = zero(a[this.n]); }
	clear(): void { this.clear_(0, this.n); this.n = 0; }
	resize_ul(c: L): void {
		const m = Number(c), n = this.n;
		if (m > n) {
			const f = this.mk !== null ? this.mk : this.em;
			if (f !== null) {
				const v0 = f();
				this.grow_(m, v0);
				const a = this.a;
				a[n] = v0;
				if (plain(v0)) a.fill(v0, n + 1, m);
				else for (let i = n + 1; i < m; i++) a[i] = f();
			} else this.grow_(m, undefined);
		} else this.clear_(m, n);
		this.n = m;
	}
	resize_ul_T(c: L, v: T): void {
		const m = Number(c), n = this.n;
		if (m > n) {
			this.grow_(m, v);
			const a = this.a;
			for (let i = n; i < m; i++) a[i] = copy(v);
		} else this.clear_(m, n);
		this.n = m;
	}
	assign_ul_T(c: L, v: T): void {
		const m = Number(c);
		if (m > this.a.length) {
			const na: T[] = [];
			for (let i = 0; i < m; i++) na.push(copy(v));
			this.a = na;
		} else {
			this.clear_(0, this.a.length);
			for (let i = 0; i < m; i++) this.a[i] = copy(v);
		}
		this.n = m;
	}
	assign_IterT_IterT(b: Iter<T>, e: Iter<T>): void {
		const m = e.i - b.i, src = b.a, o = b.i, na: T[] = [];
		for (let i = 0; i < m; i++) na.push(copy(src[o + i]));
		this.a = na; this.n = m;
	}
	assign_TA(il: T[]): void {
		const na: T[] = [];
		for (let i = 0; i < il.length; i++) na.push(copy(il[i]));
		this.a = na; this.n = il.length;
	}
	shrink_to_fit(): void { if (this.a.length !== this.n) this.a = this.a.slice(0, this.n); }
	swap(o: Vec<T>): void {
		const a = this.a; this.a = o.a; o.a = a;
		const n = this.n; this.n = o.n; o.n = n;
	}

	begin(): Iter<T> { return new Iter<T>(this, this.a, 0); }
	end(): Iter<T> { return new Iter<T>(this, this.a, this.n); }
	cbegin(): Iter<T> { return this.begin(); }
	cend(): Iter<T> { return this.end(); }
	rbegin(): RevIter<T> { return new RevIter<T>(this, this.n); }
	rend(): RevIter<T> { return new RevIter<T>(this, 0); }

	insert_IterT_T(pos: Iter<T>, v: T): Iter<T> {
		const p = pos.i;
		this.grow_(this.n + 1, v);
		this.a.copyWithin(p + 1, p, this.n);
		this.a[p] = v;
		this.n++;
		return new Iter<T>(this, this.a, p);
	}
	/** Insert copies of m elements of src from off at p. */
	private insertCopies_(p: number, src: T[], off: number, m: number): Iter<T> {
		const tmp: T[] = [];
		for (let i = 0; i < m; i++) tmp.push(copy(src[off + i]));
		this.grow_(this.n + m, tmp[0]);
		const a = this.a;
		a.copyWithin(p + m, p, this.n);
		for (let i = 0; i < m; i++) a[p + i] = tmp[i];
		this.n += m;
		return new Iter<T>(this, a, p);
	}
	insert_IterT_IterT_IterT(pos: Iter<T>, b: Iter<T>, e: Iter<T>): Iter<T> { return this.insertCopies_(pos.i, b.a, b.i, e.i - b.i); }
	/** insert(pos, {a, b, c}): the initializer list's elements, copied. */
	insert_IterT_TA(pos: Iter<T>, il: T[]): Iter<T> { return this.insertCopies_(pos.i, il, 0, il.length); }
	insert_IterT_PtrT_PtrT(pos: Iter<T>, b: Ptr<T>, e: Ptr<T>): Iter<T> { return this.insertCopies_(pos.i, b.a, b.o, e.o - b.o); }
	insert_IterT_ul_T(pos: Iter<T>, cnt: L, v: T): Iter<T> {
		const p = pos.i, m = Number(cnt);
		this.grow_(this.n + m, v);
		const a = this.a;
		a.copyWithin(p + m, p, this.n);
		for (let i = 0; i < m; i++) a[p + i] = copy(v);
		this.n += m;
		return new Iter<T>(this, a, p);
	}
	erase_IterT(pos: Iter<T>): Iter<T> {
		const p = pos.i, a = this.a;
		a.copyWithin(p, p + 1, this.n);
		this.n--;
		a[this.n] = zero(a[this.n]);
		return new Iter<T>(this, a, p);
	}
	erase_IterT_IterT(b: Iter<T>, e: Iter<T>): Iter<T> {
		const p = b.i, q = e.i, a = this.a;
		a.copyWithin(p, q, this.n);
		const m = q - p;
		this.clear_(this.n - m, this.n);
		this.n -= m;
		return new Iter<T>(this, a, p);
	}

	/** The n elements copied into a new array of length n. */
	private copyElems_(): T[] {
		const n = this.n, s = this.a.slice(0, n);
		if (n > 0) {
			const t = typeof s[0];
			if (t === 'object' || t === 'undefined') for (let i = 0; i < n; i++) s[i] = copy(s[i]);
		}
		return s;
	}
	Clone(): Vec<T> {
		const v = new Vec<T>(this.em === null ? undefined : this.em);
		v.mk = this.mk;
		v.a = this.copyElems_();
		v.n = this.n;
		return v;
	}
	/** ICopy's Assign. */
	Assign(o: Vec<T>): void { this.Assign_VecT(o); }
	Assign_VecT(o: Vec<T>): void {
		if (this === o) return;
		this.a = o.copyElems_();
		this.n = o.n;
		if (this.mk === null) this.mk = o.mk;
		if (this.em === null) this.em = o.em;
	}
	/** Move-assign: take o's storage and leave o empty, as libstdc++ does. */
	MoveFrom_VecT(o: Vec<T>): void {
		if (this === o) return;
		this.a = o.a; this.n = o.n;
		if (this.mk === null) this.mk = o.mk;
		if (this.em === null) this.em = o.em;
		o.a = []; o.n = 0;
	}
	Assign_TA(il: T[]): void { this.assign_TA(il); }
	/** v = {a, b, c}. */
	MoveFrom_TA(il: T[]): void { this.assign_TA(il); }
	/** MoveFrom of either kind (for callers that do not know which). */
	MoveFrom(o: Vec<T> | T[]): void { if (Array.isArray(o)) this.assign_TA(o); else this.MoveFrom_VecT(o); }

	static Eq<T>(x: Vec<T>, y: Vec<T>): boolean {
		if (x.n !== y.n) return false;
		const a = x.a, b = y.a;
		for (let i = 0; i < x.n; i++) if (!eq(a[i], b[i])) return false;
		return true;
	}
	/** The elements, for for-of. */
	*Items(): IterableIterator<T> { for (let i = 0; i < this.n; i++) yield this.a[i]; }
}

// ---------------------------------------------------------------- iterators
/** A vector iterator: the vector (null when made from a bare array), its storage when made, and an index. An
 *  immutable value; arithmetic on a vector's iterator re-reads the vector's current storage, as the C# does. */
export class Iter<T> {
	readonly v: Vec<T> | null;
	readonly a: T[];
	readonly i: number;
	constructor(v: Vec<T> | null, a: T[], i: number) { this.v = v; this.a = a; this.i = i; }

	static readonly ZERO: Iter<any> = new Iter<any>(null, null, 0);
	static new_VecT_l<T>(v: Vec<T>, i: L): Iter<T> { return new Iter<T>(v, v.a, lng(i)); }
	static new_TA_l<T>(a: T[], i: L): Iter<T> { return new Iter<T>(null, a, lng(i)); }

	Clone(): Iter<T> { return this; }
	get_Deref(): T { return this.a[this.i]; }
	set_Deref(x: T): void { this.a[this.i] = x; }
	ref_Deref(): Ref<T> { return new ArrRef<T>(this.a, this.i); }
	get_Item(k: L): T { return this.a[this.i + lng(k)]; }
	set_Item(k: L, x: T): void { this.a[this.i + lng(k)] = x; }
	ref_Item(k: L): Ref<T> { return new ArrRef<T>(this.a, this.i + lng(k)); }

	static op_Add<T>(x: Iter<T>, k: L): Iter<T> { const v = x.v; return new Iter<T>(v, v !== null ? v.a : x.a, x.i + lng(k)); }
	static op_Sub_IterT_l<T>(x: Iter<T>, k: L): Iter<T> { const v = x.v; return new Iter<T>(v, v !== null ? v.a : x.a, x.i - lng(k)); }
	static op_Sub_IterT_IterT<T>(x: Iter<T>, y: Iter<T>): L { return x.i - y.i; }
	static op_Increment<T>(x: Iter<T>): Iter<T> { return Iter.op_Add(x, 1); }
	static op_Decrement<T>(x: Iter<T>): Iter<T> { return Iter.op_Add(x, -1); }
	static op_Eq<T>(x: Iter<T>, y: Iter<T>): boolean { return x.i === y.i; }
	static op_Ne<T>(x: Iter<T>, y: Iter<T>): boolean { return x.i !== y.i; }
	static op_Lt<T>(x: Iter<T>, y: Iter<T>): boolean { return x.i < y.i; }
	static op_Gt<T>(x: Iter<T>, y: Iter<T>): boolean { return x.i > y.i; }
	static op_Le<T>(x: Iter<T>, y: Iter<T>): boolean { return x.i <= y.i; }
	static op_Ge<T>(x: Iter<T>, y: Iter<T>): boolean { return x.i >= y.i; }
	Equals_IterT(o: Iter<T>): boolean { return this.i === o.i; }
	Equals_o(o: any): boolean { return o instanceof Iter && o.i === this.i; }
	GetHashCode(): number { return this.i | 0; }
}

/** std::reverse_iterator over a vector: i is one past the element it designates. */
export class RevIter<T> {
	readonly v: Vec<T>;
	readonly i: number;
	constructor(v: Vec<T>, i: L) { this.v = v; this.i = lng(i); }

	static readonly ZERO: RevIter<any> = new RevIter<any>(null, 0);
	Clone(): RevIter<T> { return this; }
	get_Deref(): T { return this.v.a[this.i - 1]; }
	set_Deref(x: T): void { this.v.a[this.i - 1] = x; }
	ref_Deref(): Ref<T> { return new ArrRef<T>(this.v.a, this.i - 1); }
	static op_Increment<T>(x: RevIter<T>): RevIter<T> { return new RevIter<T>(x.v, x.i - 1); }
	static op_Eq<T>(x: RevIter<T>, y: RevIter<T>): boolean { return x.i === y.i; }
	static op_Ne<T>(x: RevIter<T>, y: RevIter<T>): boolean { return x.i !== y.i; }
	Equals_o(o: any): boolean { return o instanceof RevIter && o.i === this.i; }
	GetHashCode(): number { return this.i | 0; }
}

// ---------------------------------------------------------------- raw pointers
/** A raw pointer to T inside an array: the array and an offset; null has a null array. A pointer made by
 *  &obj.field keeps the object and a RefAt of the field instead (a and o unused): reads and writes go to the field.
 *  An immutable value. */
export class Ptr<T> {
	readonly a: T[];
	readonly o: number;
	readonly ob: any;
	readonly at: RefAt<T> | null;
	constructor(a: T[], o: number, ob: any = null, at: RefAt<T> | null = null) { this.a = a; this.o = o; this.ob = ob; this.at = at; }

	/** default(Ptr<T>): the null pointer. */
	static readonly ZERO: Ptr<any> = new Ptr<any>(null, 0, null, null);
	/** Ptr(T[] a, long o). */
	static new_TA_l<T>(a: T[], o: L): Ptr<T> { return new Ptr<T>(a, typeof o === 'number' ? o : lng(o), null, null); }
	/** Ptr(object ob, RefAt<T> at): &ob.field. */
	static new_o_RefAtT<T>(ob: any, at: RefAt<T>): Ptr<T> { return new Ptr<T>(null, 0, ob, at); }

	Clone(): Ptr<T> { return this; }
	get_IsNull(): boolean { return this.a == null && this.at === null; }

	get_Item_i(i: number): T { const at = this.at; return at === null ? this.a[this.o + i] : at(this.ob).get(); }
	get_Item_l(i: L): T { const at = this.at; return at === null ? this.a[this.o + lng(i)] : at(this.ob).get(); }
	get_Item_ul(i: L): T { const at = this.at; return at === null ? this.a[this.o + lng(i)] : at(this.ob).get(); }
	set_Item_i(i: number, v: T): void { const at = this.at; if (at === null) this.a[this.o + i] = v; else at(this.ob).set(v); }
	set_Item_l(i: L, v: T): void { const at = this.at; if (at === null) this.a[this.o + lng(i)] = v; else at(this.ob).set(v); }
	set_Item_ul(i: L, v: T): void { const at = this.at; if (at === null) this.a[this.o + lng(i)] = v; else at(this.ob).set(v); }
	ref_Item_i(i: number): Ref<T> { const at = this.at; return at === null ? new ArrRef<T>(this.a, this.o + i) : at(this.ob); }
	ref_Item_l(i: L): Ref<T> { const at = this.at; return at === null ? new ArrRef<T>(this.a, this.o + lng(i)) : at(this.ob); }
	ref_Item_ul(i: L): Ref<T> { const at = this.at; return at === null ? new ArrRef<T>(this.a, this.o + lng(i)) : at(this.ob); }
	get_Deref(): T { const at = this.at; return at === null ? this.a[this.o] : at(this.ob).get(); }
	set_Deref(v: T): void { const at = this.at; if (at === null) this.a[this.o] = v; else at(this.ob).set(v); }
	ref_Deref(): Ref<T> { const at = this.at; return at === null ? new ArrRef<T>(this.a, this.o) : at(this.ob); }

	static op_Add_PtrT_l<T>(p: Ptr<T>, k: L): Ptr<T> { return new Ptr<T>(p.a, p.o + (typeof k === 'number' ? k : lng(k)), p.ob, p.at); }
	static op_Add_PtrT_ul<T>(p: Ptr<T>, k: L): Ptr<T> { return new Ptr<T>(p.a, p.o + lng(k), p.ob, p.at); }
	static op_Sub_PtrT_l<T>(p: Ptr<T>, k: L): Ptr<T> { return new Ptr<T>(p.a, p.o - lng(k), p.ob, p.at); }
	static op_Sub_PtrT_PtrT<T>(p: Ptr<T>, q: Ptr<T>): L { return p.o - q.o; }
	static op_Increment<T>(p: Ptr<T>): Ptr<T> { return new Ptr<T>(p.a, p.o + 1, p.ob, p.at); }
	static op_Decrement<T>(p: Ptr<T>): Ptr<T> { return new Ptr<T>(p.a, p.o - 1, p.ob, p.at); }
	/** Two field pointers are equal when they reach the same object through the same getter (C# compares the
	 *  delegates' methods); two array pointers when the arrays are the same and, unless both are null, the offsets too. */
	static op_Eq<T>(p: Ptr<T>, q: Ptr<T>): boolean {
		if (p.at !== null || q.at !== null)
			return q.at !== null && p.at !== null && p.ob === q.ob && p.at === q.at && p.o === q.o;
		if (p.a == null) return q.a == null;
		return p.a === q.a && p.o === q.o;
	}
	static op_Ne<T>(p: Ptr<T>, q: Ptr<T>): boolean { return !Ptr.op_Eq(p, q); }
	static op_Lt<T>(p: Ptr<T>, q: Ptr<T>): boolean { return p.o < q.o; }
	static op_Gt<T>(p: Ptr<T>, q: Ptr<T>): boolean { return p.o > q.o; }
	static op_Le<T>(p: Ptr<T>, q: Ptr<T>): boolean { return p.o <= q.o; }
	static op_Ge<T>(p: Ptr<T>, q: Ptr<T>): boolean { return p.o >= q.o; }
	Equals_PtrT(q: Ptr<T>): boolean { return Ptr.op_Eq(this, q); }
	Equals_o(x: any): boolean { return x instanceof Ptr && Ptr.op_Eq(this, x); }
	GetHashCode(): number { return this.o | 0; }
	static from_IterT<T>(it: Iter<T>): Ptr<T> { return new Ptr<T>(it.a, it.i, null, null); }
}

// ---------------------------------------------------------------- std::span
/** std::span<T>: a view of n elements of the array a starting at o. */
export class CSpan<T> {
	readonly a: T[];
	readonly o: number;
	readonly n: number;
	constructor(a: T[], o: L, n: L) { this.a = a; this.o = lng(o); this.n = lng(n); }
	/** default(CSpan<T>): no array, empty. */
	static readonly ZERO: CSpan<any> = new CSpan<any>(null, 0, 0);
	get_Item(i: L): T { return this.a[this.o + lng(i)]; }
	ref_Item(i: L): Ref<T> { return new ArrRef<T>(this.a, this.o + lng(i)); }
	size(): L { return this.n; }
	empty(): boolean { return this.n === 0; }
	data(): Ptr<T> { return new Ptr<T>(this.a == null ? [] : this.a, this.o, null, null); }
	front(): T { return this.a[this.o]; }
	ref_front(): Ref<T> { return new ArrRef<T>(this.a, this.o); }
	back(): T { return this.a[this.o + this.n - 1]; }
	ref_back(): Ref<T> { return new ArrRef<T>(this.a, this.o + this.n - 1); }
	subspan(off: L, cnt: L = 18446744073709551615n): CSpan<T> {
		const k = lng(off);
		return new CSpan<T>(this.a, this.o + k, cnt == 18446744073709551615n ? this.n - k : lng(cnt));
	}
	first(cnt: L): CSpan<T> { return new CSpan<T>(this.a, this.o, lng(cnt)); }
	last(cnt: L): CSpan<T> { const k = lng(cnt); return new CSpan<T>(this.a, this.o + this.n - k, k); }
	Clone(): CSpan<T> { return this; }
	Equals_o(x: any): boolean { return x instanceof CSpan && x.a === this.a && x.o === this.o && x.n === this.n; }
}

// ---------------------------------------------------------------- std::pair, std::optional
/** std::pair: a mutable class so p.first = x works through references. */
export class Pair<A, B> implements ICopy<Pair<A, B>> {
	first: A;
	second: B;
	/** new Pair<A, B>(makerA, makerB): each member made by its maker (C#'s Pair(), Elem<A>.Make, Elem<B>.Make); a
	 *  missing maker gives null. (The third argument is internal: true when x and y are the members themselves.) */
	constructor(x?: any, y?: any, values?: boolean) {
		if (values === true) { this.first = x; this.second = y; }
		else { this.first = x == null ? null : x(); this.second = y == null ? null : y(); }
	}
	/** Pair(A a, B b). */
	static new_A_B<A, B>(a: A, b: B): Pair<A, B> { return new Pair<A, B>(a, b, true); }
	Clone(): Pair<A, B> { return new Pair<A, B>(copy(this.first), copy(this.second), true); }
	Assign(o: Pair<A, B>): void { this.first = copy(o.first); this.second = copy(o.second); }
	/** std::pair's operator<: first, then second (each by Less<T>.Fn). */
	CompareTo(o: Pair<A, B>): number {
		const lt = (cpp as any).Less.Fn as (a: any, b: any) => boolean;
		if (lt(this.first, o.first)) return -1;
		if (lt(o.first, this.first)) return 1;
		if (lt(this.second, o.second)) return -1;
		if (lt(o.second, this.second)) return 1;
		return 0;
	}
	static op_Lt<A, B>(x: Pair<A, B>, y: Pair<A, B>): boolean { return x.CompareTo(y) < 0; }
	static op_Gt<A, B>(x: Pair<A, B>, y: Pair<A, B>): boolean { return x.CompareTo(y) > 0; }
	static op_Le<A, B>(x: Pair<A, B>, y: Pair<A, B>): boolean { return x.CompareTo(y) <= 0; }
	static op_Ge<A, B>(x: Pair<A, B>, y: Pair<A, B>): boolean { return x.CompareTo(y) >= 0; }
	static Eq<A, B>(x: Pair<A, B>, y: Pair<A, B>): boolean { return eq(x.first, y.first) && eq(x.second, y.second); }
}

/** std::optional<T>: has, and the value val (meaningful only while has). */
export class Opt<T> implements ICopy<Opt<T>> {
	has: boolean;
	val: T;
	/** new Opt<T>(maker): empty (C#'s Opt()). val is null until a value is set (C# has default(T); reading val of an
	 *  empty optional is undefined behaviour in C++). */
	constructor(mk?: () => T) { this.has = false; this.val = null; }
	/** Opt(T v). */
	static new_T<T>(v: T, mk?: () => T): Opt<T> { const o = new Opt<T>(); o.has = true; o.val = v; return o; }
	DestroyElems(): void { if (this.has) Dtor.Run(this.val); }
	has_value(): boolean { return this.has; }
	value(): T { if (!this.has) throw new BadOptionalAccess(); return this.val; }
	ref_value(): Ref<T> { if (!this.has) throw new BadOptionalAccess(); return new FieldRef<T>(this, "val"); }
	get_Deref(): T { return this.val; }
	set_Deref(v: T): void { this.val = v; }
	ref_Deref(): Ref<T> { return new FieldRef<T>(this, "val"); }
	value_or(d: T): T { return this.has ? this.val : d; }
	reset(): void { this.has = false; this.val = zero(this.val); }
	MoveFrom(o: Opt<T>): void { if (this === o) return; this.has = o.has; this.val = o.val; }
	emplace(v: T): T { this.has = true; this.val = v; return v; }
	ref_emplace(v: T): Ref<T> { this.has = true; this.val = v; return new FieldRef<T>(this, "val"); }
	Clone(): Opt<T> {
		if (this.has) return Opt.new_T<T>(copy(this.val));
		const c = new Opt<T>(); c.val = zero(this.val); return c;
	}
	Assign(o: Opt<T>): void { this.has = o.has; this.val = o.has ? copy(o.val) : zero(o.val); }
	Set(v: T): void { this.has = true; this.val = v; }
}

// ---------------------------------------------------------------- arrays
/** std::array, std::fill, std::copy and the small helpers on plain arrays. */
export class Arr {
	/** T a[n][m]: n rows of m (each a fresh array). */
	static Make2<T>(n: number, m: number, mk?: () => T): T[][] {
		const a: T[][] = [];
		for (let i = 0; i < n; i++) a.push(Arr.Make<T>(m, mk));
		return a;
	}
	/** std::array<std::array<T, m>, n> and the like: n elements, each made by mk. */
	static MakeWith<T>(n: number, mk: () => T): T[] { const a: T[] = []; pushMade(a, mk, n); return a; }
	/** new T[n]: n elements made by mk (C#: default(T), or Elem<T>.Make for a class). */
	static Make<T>(n: number, mk?: () => T): T[] {
		const a: T[] = [];
		if (mk == null) for (let i = 0; i < n; i++) a.push(null);
		else pushMade(a, mk, n);
		return a;
	}
	/** A copy of the array; class elements (ICopy) are cloned, anything else (arrays included) is shared. */
	static Clone<T>(a: T[]): T[] {
		if (a == null) return null;
		const b = a.slice();
		if (b.length > 0 && typeof b[0] === 'object')
			for (let i = 0; i < b.length; i++) {
				const x: any = b[i];
				if (x !== null && typeof x === 'object' && !Array.isArray(x) && typeof x.Clone === 'function' && typeof x.Assign === 'function') b[i] = x.Clone();
			}
		return b;
	}
	/** dst = src element by element: a class element is Assign-ed in place, anything else is stored. */
	static Assign<T>(dst: T[], src: T[]): void {
		for (let i = 0; i < src.length; i++) {
			const d: any = dst[i];
			if (d !== null && typeof d === 'object' && !Array.isArray(d) && typeof d.Assign === 'function' && typeof d.Clone === 'function') d.Assign(src[i]);
			else dst[i] = src[i];
		}
	}
	static Fill<T>(a: T[], b: L, e: L, v: T): void { for (let i = Number(b), k = Number(e); i < k; i++) a[i] = copy(v); }
	static Eq<T>(x: T[], y: T[]): boolean {
		if (x.length !== y.length) return false;
		for (let i = 0; i < x.length; i++) if (!eq(x[i], y[i])) return false;
		return true;
	}
}

// ---------------------------------------------------------------- std::min / max / clamp
/** std::min / std::max / std::clamp exactly as libstdc++ writes them (the comparisons decide which argument comes
 *  back, which matters for -0.0 and NaN). */
export class M {
	static min_d_d(a: number, b: number): number { return (b < a) ? b : a; }
	static max_d_d(a: number, b: number): number { return (a < b) ? b : a; }
	static min_f_f(a: number, b: number): number { return (b < a) ? b : a; }
	static max_f_f(a: number, b: number): number { return (a < b) ? b : a; }
	static min_i_i(a: number, b: number): number { return (b < a) ? b : a; }
	static max_i_i(a: number, b: number): number { return (a < b) ? b : a; }
	static min_l_l(a: L, b: L): L { return (b < a) ? b : a; }
	static max_l_l(a: L, b: L): L { return (a < b) ? b : a; }
	static min_ul_ul(a: L, b: L): L { return (b < a) ? b : a; }
	static max_ul_ul(a: L, b: L): L { return (a < b) ? b : a; }
	static min_u_u(a: number, b: number): number { return (b < a) ? b : a; }
	static max_u_u(a: number, b: number): number { return (a < b) ? b : a; }
	static min_uc_uc(a: number, b: number): number { return (b < a) ? b : a; }
	static max_uc_uc(a: number, b: number): number { return (a < b) ? b : a; }
	static min_c_c(a: number, b: number): number { return (b < a) ? b : a; }
	static max_c_c(a: number, b: number): number { return (a < b) ? b : a; }
	static min_s_s(a: number, b: number): number { return (b < a) ? b : a; }
	static max_s_s(a: number, b: number): number { return (a < b) ? b : a; }
	static min_us_us(a: number, b: number): number { return (b < a) ? b : a; }
	static max_us_us(a: number, b: number): number { return (a < b) ? b : a; }
	static min_T_T_FuncTTb<T>(a: T, b: T, lt: (x: T, y: T) => boolean): T { return lt(b, a) ? b : a; }
	static max_T_T_FuncTTb<T>(a: T, b: T, lt: (x: T, y: T) => boolean): T { return lt(a, b) ? b : a; }
	// std::clamp(v, lo, hi): (v < lo) ? lo : (hi < v) ? hi : v
	static clamp_d_d_d(v: number, lo: number, hi: number): number { return (v < lo) ? lo : (hi < v) ? hi : v; }
	static clamp_i_i_i(v: number, lo: number, hi: number): number { return (v < lo) ? lo : (hi < v) ? hi : v; }
	static clamp_l_l_l(v: L, lo: L, hi: L): L { return (v < lo) ? lo : (hi < v) ? hi : v; }
	// initializer-list forms: the first smallest / first largest
	static min_dA(il: number[]): number { let r = il[0]; for (let i = 1; i < il.length; i++) if (il[i] < r) r = il[i]; return r; }
	static max_dA(il: number[]): number { let r = il[0]; for (let i = 1; i < il.length; i++) if (r < il[i]) r = il[i]; return r; }
	static min_iA(il: number[]): number { let r = il[0]; for (let i = 1; i < il.length; i++) if (il[i] < r) r = il[i]; return r; }
	static max_iA(il: number[]): number { let r = il[0]; for (let i = 1; i < il.length; i++) if (r < il[i]) r = il[i]; return r; }
}

// ---------------------------------------------------------------- the C++ exceptions
function msgOf(m: Str | string): Str { return typeof m === 'string' ? Str.new_str(m) : m.Clone(); }

/** std::exception: msg is what what() returns. An Error, so an uncaught one shows its message and stack. */
export class CppException extends Error {
	readonly msg: Str;
	/** new CppException(): "std::exception" (the constructor engine classes call as super()); with an argument, the
	 *  message (a Str is copied, a string is Latin-1). */
	constructor(m?: Str | string) {
		const s = m === undefined ? Str.new_str("std::exception") : msgOf(m);
		super(s.toString());
		this.msg = s;
	}
	static new_Str(m: Str): CppException { return new CppException(m); }
	what(): CPtr { return this.msg.c_str(); }
}
export class LogicError extends CppException {
	constructor(m: Str | string) { super(m); }
	static new_Str(m: Str): LogicError { return new LogicError(m); }
	static new_str(m: string): LogicError { return new LogicError(m); }
}
export class RuntimeError extends CppException {
	constructor(m: Str | string) { super(m); }
	static new_Str(m: Str): RuntimeError { return new RuntimeError(m); }
	static new_str(m: string): RuntimeError { return new RuntimeError(m); }
}
export class InvalidArgument extends LogicError {
	constructor(m: Str | string) { super(m); }
	static new_Str(m: Str): InvalidArgument { return new InvalidArgument(m); }
	static new_str(m: string): InvalidArgument { return new InvalidArgument(m); }
}
export class OutOfRange extends LogicError {
	constructor(m: Str | string) { super(m); }
	static new_Str(m: Str): OutOfRange { return new OutOfRange(m); }
	static new_str(m: string): OutOfRange { return new OutOfRange(m); }
}
export class LengthError extends LogicError {
	constructor(m: Str | string) { super(m); }
	static new_Str(m: Str): LengthError { return new LengthError(m); }
	static new_str(m: string): LengthError { return new LengthError(m); }
}
export class DomainError extends LogicError {
	constructor(m: Str | string) { super(m); }
	static new_Str(m: Str): DomainError { return new DomainError(m); }
	static new_str(m: string): DomainError { return new DomainError(m); }
}
export class RangeError extends RuntimeError {
	constructor(m: Str | string) { super(m); }
	static new_Str(m: Str): RangeError { return new RangeError(m); }
	static new_str(m: string): RangeError { return new RangeError(m); }
}
export class OverflowError extends RuntimeError {
	constructor(m: Str | string) { super(m); }
	static new_Str(m: Str): OverflowError { return new OverflowError(m); }
	static new_str(m: string): OverflowError { return new OverflowError(m); }
}
export class BadAlloc extends CppException { constructor() { super("std::bad_alloc"); } }
export class BadOptionalAccess extends CppException { constructor() { super("bad optional access"); } }
export class BadFunctionCall extends CppException { constructor() { super("bad_function_call"); } }
/** Thrown by std::get on a variant (Std.cs declares it with Variant). */
export class BadVariantAccess extends CppException { constructor() { super("std::get: wrong index for variant"); } }

// ---------------------------------------------------------------- Misc.cs: Box, Dtor, Defer, Mv
/** A reference member of a class (bool& held by an object): the place it refers to, an array cell or a field of some
 *  object (a getter of a Ref to it). */
export class Box<T> {
	a: T[];
	o: number;
	private readonly g: (() => Ref<T>) | null;
	constructor(a: T[], o: number, g: (() => Ref<T>) | null) { this.a = a; this.o = o; this.g = g; }
	/** Box(T[] a, long o). */
	static new_TA_l<T>(a: T[], o: L): Box<T> { return new Box<T>(a, lng(o), null); }
	/** Box(RefGet<T> g). */
	static new_RefGetT<T>(g: () => Ref<T>): Box<T> { return new Box<T>(null, 0, g); }
	static Of<T>(g: () => Ref<T>): Box<T> { return new Box<T>(null, 0, g); }
	ref_V(): Ref<T> { return this.g !== null ? this.g() : new ArrRef<T>(this.a, this.o); }
	get_V(): T { return this.g !== null ? this.g().get() : this.a[this.o]; }
	set_V(v: T): void { if (this.g !== null) this.g().set(v); else this.a[this.o] = v; }
}

/** Runs a C++ destructor: an object's Dispose (an engine class's destructor, a file stream's close), a container's
 *  DestroyElems (its elements), an array's elements in order. */
export class Dtor {
	static Run(o: any): void {
		if (o == null || typeof o !== 'object') return;
		if (typeof o.Dispose === 'function') { o.Dispose(); return; }
		if (typeof o.DestroyElems === 'function') { o.DestroyElems(); return; }
		if (Array.isArray(o)) for (let i = 0; i < o.length; i++) Dtor.Run(o[i]);
	}
}

/** A destructor deferred to the end of the enclosing block (a using declaration), unless the object is returned. */
export class Defer {
	private a: (() => void) | null;
	constructor(a: () => void) { this.a = a; }
	Cancel(): void { this.a = null; }
	Dispose(): void { const x = this.a; this.a = null; if (x !== null) x(); }
}

/** Moves and out-parameter copy-back. */
export class Mv {
	/** unique_ptr::reset(p) and unique_ptr assignment: store the new pointer, then delete the old one. */
	static Reset<T>(p: Ref<T>, q: T): void { const old = p.get(); p.set(q); if (old != null && old !== q) Dtor.Run(old); }
	/** Copy a boxed out-parameter back into its variable after the call produced value v. */
	static Back<R, T>(v: R, x: Ref<T>, box: T[]): R { x.set(box[0]); return v; }
	/** std::move of a container or class into a new owner: the source is left as its maker makes it (empty). */
	static Take<T>(x: Ref<T>, mk?: () => T): T { const r = x.get(); x.set(mk == null ? null : mk()); return r; }
	/** std::move of a unique_ptr or std::function: the source is left null. */
	static TakeRef<T>(x: Ref<T>): T { const r = x.get(); x.set(null); return r; }
	static PostStep_PtrTr_i<T>(p: Ref<Ptr<T>>, d: number): Ptr<T> { const r = p.get(); p.set(Ptr.op_Add_PtrT_l(r, d)); return r; }
	static PostStep_IterTr_i<T>(p: Ref<Iter<T>>, d: number): Iter<T> { const r = p.get(); p.set(Iter.op_Add(r, d)); return r; }
	static PostStep_CPtrr_i(p: Ref<CPtr>, d: number): CPtr { const r = p.get(); p.set(CPtr.op_Add_CPtr_i(r, d)); return r; }
	static PostStep_MItEr_i(p: Ref<any>, d: number): any {
		const r = p.get(), MIt = (cpp as any).MIt;
		p.set(d > 0 ? MIt.op_Increment(r) : MIt.op_Decrement(r));
		return r;
	}
	static PostStep_RevIterTr_i<T>(p: Ref<RevIter<T>>, d: number): RevIter<T> { const r = p.get(); p.set(RevIter.op_Increment(r)); return r; }
	static Delete(o: any): void { if (o != null && typeof o.Dispose === 'function') o.Dispose(); }
}
