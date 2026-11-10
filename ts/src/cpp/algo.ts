// algo.ts - <algorithm> and <numeric> over vector / array iterators and pointers: the Algo class of the C# runtime
// (cs/runtime/Misc.cs, the specification), with libstdc++'s order of comparisons and moves where it shows (unique,
// lower_bound, min/max_element ties). Elements are copied as C#'s Elem<T>.Copy does, compared as
// EqualityComparer<T>.Default and ordered by Less<T>.Fn (CtElem, containers.ts). An Iter is (a, i), a Ptr (a, o);
// results are made with the runtime's own Iter / Ptr arithmetic, so they are what the C# operators give.
// Overloaded C# names carry the parameter-code suffix the Go translator uses (fill_IterT_IterT_T, ...).
// One difference from the C#: VecFrom / VecFromPtr give the new vector an element maker (C#: Elem<T>.Make, from
// the static type), the source vector's when the iterator has its vector, else one the elements' values imply.
// Checked against libstdc++ by tests/stdcheck (containercheck.mts, run_ts.sh).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.
import * as cpp from './index.js';
import { CtElem } from './containers.js';

type L = number | bigint;

/** A long index as a number. */
function ix(x: L): number { return typeof x === 'number' ? x : Number(x); }

function iterAt<T>(b: cpp.Iter<T>, k: number): cpp.Iter<T> { return k === 0 ? b : cpp.Iter.op_Add(b, k); }

/** The element maker of the new vector (C#'s new Vec<T>(): no explicit mk, Elem<T>.Make from the static type): the
 *  source vector's element maker em when the iterator has its vector, else one from the element type as the values
 *  show it. */
function makerOf<T>(b: any, sample: any): () => T {
	const v = b != null ? b.v : null;
	if (v != null && typeof v.em === 'function') return v.em;
	switch (typeof sample) {
		case 'number': case 'bigint': return (() => 0) as any;
		case 'boolean': return (() => false) as any;
		case 'object':
			if (sample instanceof cpp.Str) return (() => new cpp.Str()) as any;
			return (() => null) as any;
		default: return (() => null) as any;
	}
}

export class Algo {
	static fill_IterT_IterT_T<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: T): void {
		const a = b.a as any[], lo = ix(b.i), hi = ix(e.i);
		if (v === null || typeof v !== 'object') { for (let i = lo; i < hi; i++) a[i] = v; return; }
		for (let i = lo; i < hi; i++) a[i] = CtElem.Copy(v);
	}
	static fill_PtrT_PtrT_T<T>(b: cpp.Ptr<T>, e: cpp.Ptr<T>, v: T): void {
		const a = b.a as any[], lo = ix(b.o), hi = ix(e.o);
		for (let i = lo; i < hi; i++) a[i] = CtElem.Copy(v);
	}
	static fill_n_IterT_ul_T<T>(b: cpp.Iter<T>, n: L, v: T): cpp.Iter<T> {
		const a = b.a as any[], o = ix(b.i), m = ix(n);
		for (let i = 0; i < m; i++) a[o + i] = CtElem.Copy(v);
		return cpp.Iter.op_Add(b, m);
	}
	static fill_n_PtrT_ul_T<T>(b: cpp.Ptr<T>, n: L, v: T): cpp.Ptr<T> {
		const a = b.a as any[], o = ix(b.o), m = ix(n);
		for (let i = 0; i < m; i++) a[o + i] = CtElem.Copy(v);
		return cpp.Ptr.op_Add_PtrT_l(b, m);
	}

	static any_of<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, f: (x: T) => boolean): boolean {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) if (f(a[i])) return true;
		return false;
	}
	static all_of<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, f: (x: T) => boolean): boolean {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) if (!f(a[i])) return false;
		return true;
	}
	static none_of<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, f: (x: T) => boolean): boolean { return !Algo.any_of(b, e, f); }
	static find<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: T): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i), hi = ix(e.i);
		for (let i = lo; i < hi; i++) if (CtElem.Eq(a[i], v)) return iterAt(b, i - lo);
		return e;
	}
	static find_if<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, f: (x: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i), hi = ix(e.i);
		for (let i = lo; i < hi; i++) if (f(a[i])) return iterAt(b, i - lo);
		return e;
	}
	static find_if_not<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, f: (x: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i), hi = ix(e.i);
		for (let i = lo; i < hi; i++) if (!f(a[i])) return iterAt(b, i - lo);
		return e;
	}
	static count<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: T): L {
		const a = b.a, hi = ix(e.i);
		let n = 0;
		for (let i = ix(b.i); i < hi; i++) if (CtElem.Eq(a[i], v)) n++;
		return n;
	}
	static count_if<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, f: (x: T) => boolean): L {
		const a = b.a, hi = ix(e.i);
		let n = 0;
		for (let i = ix(b.i); i < hi; i++) if (f(a[i])) n++;
		return n;
	}

	static accumulate_Iterd_Iterd_d(b: cpp.Iter<number>, e: cpp.Iter<number>, init: number): number {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) init = init + a[i];
		return init;
	}
	static accumulate_Iteri_Iteri_i(b: cpp.Iter<number>, e: cpp.Iter<number>, init: number): number {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) init = (init + a[i]) | 0;
		return init;
	}
	static accumulate_Iterl_Iterl_l(b: cpp.Iter<L>, e: cpp.Iter<L>, init: L): L {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) init = cpp.L.addL(init, a[i]);
		return init;
	}
	static accumulate_Iteri_Iteri_d(b: cpp.Iter<number>, e: cpp.Iter<number>, init: number): number {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) init = init + a[i];
		return init;
	}
	static accumulate_Iterul_Iterul_ul(b: cpp.Iter<L>, e: cpp.Iter<L>, init: L): L {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) init = cpp.L.addUL(init, a[i]);
		return init;
	}
	static accumulate_IterT_IterT_A_FuncATA<T, A>(b: cpp.Iter<T>, e: cpp.Iter<T>, init: A, op: (acc: A, x: T) => A): A {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) init = op(init, a[i]);
		return init;
	}

	static lower_bound_IterT_IterT_T<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: T): cpp.Iter<T> {
		return Algo.lower_bound_IterT_IterT_T_FuncTTb(b, e, v, CtElem.Less);
	}
	static lower_bound_IterT_IterT_T_FuncTTb<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: T, lt: (x: T, y: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i);
		let first = lo, len = ix(e.i) - lo;
		while (len > 0) {
			const half = Math.floor(len / 2), mid = first + half;
			if (lt(a[mid], v)) { first = mid + 1; len = len - half - 1; } else len = half;
		}
		return iterAt(b, first - lo);
	}
	static lower_bound_IterT_IterT_V_FuncTVb<T, V>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: V, lt: (x: T, y: V) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i);
		let first = lo, len = ix(e.i) - lo;
		while (len > 0) {
			const half = Math.floor(len / 2), mid = first + half;
			if (lt(a[mid], v)) { first = mid + 1; len = len - half - 1; } else len = half;
		}
		return iterAt(b, first - lo);
	}
	static upper_bound_IterT_IterT_T<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: T): cpp.Iter<T> {
		return Algo.upper_bound_IterT_IterT_T_FuncTTb(b, e, v, CtElem.Less);
	}
	static upper_bound_IterT_IterT_T_FuncTTb<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: T, lt: (x: T, y: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i);
		let first = lo, len = ix(e.i) - lo;
		while (len > 0) {
			const half = Math.floor(len / 2), mid = first + half;
			if (lt(v, a[mid])) len = half; else { first = mid + 1; len = len - half - 1; }
		}
		return iterAt(b, first - lo);
	}
	static upper_bound_IterT_IterT_V_FuncVTb<T, V>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: V, lt: (x: V, y: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i);
		let first = lo, len = ix(e.i) - lo;
		while (len > 0) {
			const half = Math.floor(len / 2), mid = first + half;
			if (lt(v, a[mid])) len = half; else { first = mid + 1; len = len - half - 1; }
		}
		return iterAt(b, first - lo);
	}
	static binary_search<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: T): boolean {
		const it = Algo.lower_bound_IterT_IterT_T(b, e, v);
		return it.i != e.i && !CtElem.Less(v, it.a[ix(it.i)]);
	}
	/** std::is_sorted: no element is less than the one before it. */
	static is_sorted_IterT_IterT<T>(b: cpp.Iter<T>, e: cpp.Iter<T>): boolean {
		return Algo.is_sorted_IterT_IterT_FuncTTb(b, e, CtElem.Less);
	}
	static is_sorted_IterT_IterT_FuncTTb<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, lt: (x: T, y: T) => boolean): boolean {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i) + 1; i < hi; i++) if (lt(a[i], a[i - 1])) return false;
		return true;
	}
	static adjacent_find_IterT_IterT<T>(b: cpp.Iter<T>, e: cpp.Iter<T>): cpp.Iter<T> {
		return Algo.adjacent_find_IterT_IterT_FuncTTb(b, e, CtElem.Eq);
	}
	static adjacent_find_IterT_IterT_FuncTTb<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, eq: (x: T, y: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i), hi = ix(e.i);
		for (let i = lo; i + 1 < hi; i++) if (eq(a[i], a[i + 1])) return iterAt(b, i - lo);
		return e;
	}
	/** std::unique: keeps the first of each run of equal elements (libstdc++'s order of moves). */
	static unique_IterT_IterT<T>(b: cpp.Iter<T>, e: cpp.Iter<T>): cpp.Iter<T> {
		return Algo.unique_IterT_IterT_FuncTTb(b, e, CtElem.Eq);
	}
	static unique_IterT_IterT_FuncTTb<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, eq: (x: T, y: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i), last = ix(e.i);
		if (lo === last) return e;
		let first = lo, nxt = first;
		while (++nxt !== last) { if (eq(a[first], a[nxt])) break; first = nxt; }      // adjacent_find
		if (nxt === last) return e;
		let dest = first;
		first = nxt;
		while (++first !== last) if (!eq(a[dest], a[first])) a[++dest] = a[first];
		return iterAt(b, dest + 1 - lo);
	}
	static remove_if<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, f: (x: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i), hi = ix(e.i);
		let first = lo;
		while (first !== hi && !f(a[first])) first++;
		if (first === hi) return e;
		let r = first;
		for (let i = first + 1; i !== hi; i++) if (!f(a[i])) a[r++] = a[i];
		return iterAt(b, r - lo);
	}
	static remove<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, v: T): cpp.Iter<T> { return Algo.remove_if(b, e, (x: T) => CtElem.Eq(x, v)); }
	static max_element_IterT_IterT<T>(b: cpp.Iter<T>, e: cpp.Iter<T>): cpp.Iter<T> {
		return Algo.max_element_IterT_IterT_FuncTTb(b, e, CtElem.Less);
	}
	static max_element_IterT_IterT_FuncTTb<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, lt: (x: T, y: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i), hi = ix(e.i);
		if (lo === hi) return e;
		let best = lo;
		for (let i = lo + 1; i < hi; i++) if (lt(a[best], a[i])) best = i;
		return iterAt(b, best - lo);
	}
	static min_element_IterT_IterT<T>(b: cpp.Iter<T>, e: cpp.Iter<T>): cpp.Iter<T> {
		return Algo.min_element_IterT_IterT_FuncTTb(b, e, CtElem.Less);
	}
	static min_element_IterT_IterT_FuncTTb<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, lt: (x: T, y: T) => boolean): cpp.Iter<T> {
		const a = b.a, lo = ix(b.i), hi = ix(e.i);
		if (lo === hi) return e;
		let best = lo;
		for (let i = lo + 1; i < hi; i++) if (lt(a[i], a[best])) best = i;
		return iterAt(b, best - lo);
	}

	static copy_IterT_IterT_IterT<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, o: cpp.Iter<T>): cpp.Iter<T> {
		const a = b.a, d = o.a as any[], lo = ix(b.i), hi = ix(e.i), oo = ix(o.i);
		for (let i = lo; i < hi; i++) d[oo + (i - lo)] = CtElem.Copy(a[i]);
		return cpp.Iter.op_Add(o, hi - lo);
	}
	static copy_IterT_IterT_PtrT<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, o: cpp.Ptr<T>): cpp.Ptr<T> {
		const a = b.a, d = o.a as any[], lo = ix(b.i), hi = ix(e.i), oo = ix(o.o);
		for (let i = lo; i < hi; i++) d[oo + (i - lo)] = CtElem.Copy(a[i]);
		return cpp.Ptr.op_Add_PtrT_l(o, hi - lo);
	}
	static copy_PtrT_PtrT_PtrT<T>(b: cpp.Ptr<T>, e: cpp.Ptr<T>, o: cpp.Ptr<T>): cpp.Ptr<T> {
		const a = b.a, d = o.a as any[], lo = ix(b.o), hi = ix(e.o), oo = ix(o.o);
		for (let i = lo; i < hi; i++) d[oo + (i - lo)] = CtElem.Copy(a[i]);
		return cpp.Ptr.op_Add_PtrT_l(o, hi - lo);
	}
	static copy_PtrT_PtrT_IterT<T>(b: cpp.Ptr<T>, e: cpp.Ptr<T>, o: cpp.Iter<T>): cpp.Iter<T> {
		const a = b.a, d = o.a as any[], lo = ix(b.o), hi = ix(e.o), oo = ix(o.i);
		for (let i = lo; i < hi; i++) d[oo + (i - lo)] = CtElem.Copy(a[i]);
		return cpp.Iter.op_Add(o, hi - lo);
	}
	static copy_n_IterT_ul_IterT<T>(b: cpp.Iter<T>, n: L, o: cpp.Iter<T>): cpp.Iter<T> {
		return Algo.copy_IterT_IterT_IterT(b, cpp.Iter.op_Add(b, ix(n)), o);
	}
	static copy_n_PtrT_ul_PtrT<T>(b: cpp.Ptr<T>, n: L, o: cpp.Ptr<T>): cpp.Ptr<T> {
		return Algo.copy_PtrT_PtrT_PtrT(b, cpp.Ptr.op_Add_PtrT_l(b, ix(n)), o);
	}
	/** transform over a string's bytes with a function returning int (::toupper and lambdas around it): each
	 *  result is stored as a char, as the C++ assignment converts it. */
	static transform_Iteruc_Iteruc_Iteruc_Funcuci(b: cpp.Iter<number>, e: cpp.Iter<number>, o: cpp.Iter<number>, f: (x: number) => number): cpp.Iter<number> {
		const a = b.a, d = o.a, lo = ix(b.i), hi = ix(e.i), oo = ix(o.i);
		for (let i = lo; i < hi; i++) d[oo + (i - lo)] = f(a[i]) & 0xff;
		return cpp.Iter.op_Add(o, hi - lo);
	}
	static transform_Iteruc_Iteruc_Iteruc_Funcucc(b: cpp.Iter<number>, e: cpp.Iter<number>, o: cpp.Iter<number>, f: (x: number) => number): cpp.Iter<number> {
		const a = b.a, d = o.a, lo = ix(b.i), hi = ix(e.i), oo = ix(o.i);
		for (let i = lo; i < hi; i++) d[oo + (i - lo)] = f(a[i]) & 0xff;
		return cpp.Iter.op_Add(o, hi - lo);
	}
	static transform_IterT_IterT_IterU_FuncTU<T, U>(b: cpp.Iter<T>, e: cpp.Iter<T>, o: cpp.Iter<U>, f: (x: T) => U): cpp.Iter<U> {
		const a = b.a, d = o.a, lo = ix(b.i), hi = ix(e.i), oo = ix(o.i);
		for (let i = lo; i < hi; i++) d[oo + (i - lo)] = f(a[i]);
		return cpp.Iter.op_Add(o, hi - lo);
	}
	static replace<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, old: T, nw: T): void {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) if (CtElem.Eq(a[i], old)) a[i] = nw;
	}
	static reverse<T>(b: cpp.Iter<T>, e: cpp.Iter<T>): void {
		const a = b.a;
		for (let i = ix(b.i), j = ix(e.i) - 1; i < j; i++, j--) { const t = a[i]; a[i] = a[j]; a[j] = t; }
	}
	static iota_Iteri_Iteri_i(b: cpp.Iter<number>, e: cpp.Iter<number>, v: number): void {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) { a[i] = v; v = (v + 1) | 0; }
	}
	static iota_Iterul_Iterul_ul(b: cpp.Iter<L>, e: cpp.Iter<L>, v: L): void {
		const a = b.a, hi = ix(e.i);
		for (let i = ix(b.i); i < hi; i++) { a[i] = v; v = cpp.L.incUL(v); }
	}
	static equal<T>(b: cpp.Iter<T>, e: cpp.Iter<T>, b2: cpp.Iter<T>): boolean {
		const a = b.a, a2 = b2.a, lo = ix(b.i), hi = ix(e.i), o2 = ix(b2.i);
		for (let i = lo; i < hi; i++) if (!CtElem.Eq(a[i], a2[o2 + (i - lo)])) return false;
		return true;
	}
	static distance_IterT_IterT<T>(a: cpp.Iter<T>, b: cpp.Iter<T>): L { return ix(b.i) - ix(a.i); }
	static distance_PtrT_PtrT<T>(a: cpp.Ptr<T>, b: cpp.Ptr<T>): L { return ix(b.o) - ix(a.o); }
	static next<T>(a: cpp.Iter<T>, n: L = 1): cpp.Iter<T> { return cpp.Iter.op_Add(a, n); }
	static prev<T>(a: cpp.Iter<T>, n: L = 1): cpp.Iter<T> { return cpp.Iter.op_Sub_IterT_l(a, n); }

	/** std::vector<T>(b, e): a new vector holding copies of the range. */
	static VecFrom<T>(b: cpp.Iter<T>, e: cpp.Iter<T>): cpp.Vec<T> {
		const src = b.a, lo = ix(b.i), m = ix(e.i) - lo;
		const v = new cpp.Vec<T>(makerOf<T>(b, m > 0 ? src[lo] : undefined));
		const arr = new Array<T>(m);
		for (let i = 0; i < m; i++) arr[i] = CtElem.Copy(src[lo + i]);
		(v as any).a = arr;
		v.n = m;
		return v;
	}
	static VecFromPtr<T>(b: cpp.Ptr<T>, e: cpp.Ptr<T>): cpp.Vec<T> {
		const src = b.a, lo = ix(b.o), m = ix(e.o) - lo;
		const v = new cpp.Vec<T>(makerOf<T>(null, m > 0 ? src[lo] : undefined));
		const arr = new Array<T>(m);
		for (let i = 0; i < m; i++) arr[i] = CtElem.Copy(src[lo + i]);
		(v as any).a = arr;
		v.n = m;
		return v;
	}
	static begin_VecT<T>(v: cpp.Vec<T>): cpp.Iter<T> { return v.begin(); }
	static end_VecT<T>(v: cpp.Vec<T>): cpp.Iter<T> { return v.end(); }
	static begin_TA<T>(a: T[]): cpp.Iter<T> { return cpp.Iter.new_TA_l(a, 0); }
	static end_TA<T>(a: T[]): cpp.Iter<T> { return cpp.Iter.new_TA_l(a, a.length); }
	static size_VecT<T>(v: cpp.Vec<T>): L { return v.size(); }
	static size_TA<T>(a: T[]): L { return a.length; }
}
