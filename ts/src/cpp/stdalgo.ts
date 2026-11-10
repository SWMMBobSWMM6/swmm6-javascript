// stdalgo.ts - libstdc++'s sorting algorithms, step for step (GCC 13 bits/stl_algo.h and bits/stl_heap.h), as the
// C# Cpp.StdAlgo (cs/runtime/StdAlgo.cs, the specification) has them. std::sort is an introsort and is not stable:
// with equal keys the order it leaves depends on every swap it makes, so the port makes the same ones, and
// std::partial_sort's heap moves are the same too. StableSort is the C# merge sort, comparison for comparison
// (any stable sort gives libstdc++'s result for a strict weak order). Indices are numbers (the C# longs; a
// cpp.L bigint argument is converted); integer divisions truncate toward zero as C#'s do.
// Checked against libstdc++ by tests/stdcheck (sortcheck.mts, containercheck.mts, run_ts.sh).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

type L = number | bigint;
type Cmp<T> = (a: T, b: T) => boolean;
type Arr<T> = { [i: number]: T; length: number };

const THRESHOLD = 16;

/** floor(log2(n)) for n >= 1 (63 - lzcnt). */
function lg(n: number): number {
	return n < 4294967296 ? 31 - Math.clz32(n) : 63 - Math.clz32(Math.floor(n / 4294967296));
}

function swap<T>(a: Arr<T>, i: number, j: number): void { const t = a[i]; a[i] = a[j]; a[j] = t; }

function introsortLoop<T>(a: Arr<T>, first: number, last: number, depth: number, comp: Cmp<T>): void {
	while (last - first > THRESHOLD) {
		if (depth === 0) {
			partialSort(a, first, last, last, comp);
			return;
		}
		--depth;
		const cut = unguardedPartitionPivot(a, first, last, comp);
		introsortLoop(a, cut, last, depth, comp);
		last = cut;
	}
}

function unguardedPartitionPivot<T>(a: Arr<T>, first: number, last: number, comp: Cmp<T>): number {
	const mid = first + Math.trunc((last - first) / 2);
	moveMedianToFirst(a, first, first + 1, mid, last - 1, comp);
	return unguardedPartition(a, first + 1, last, first, comp);
}

function moveMedianToFirst<T>(x: Arr<T>, result: number, a: number, b: number, c: number, comp: Cmp<T>): void {
	if (comp(x[a], x[b])) {
		if (comp(x[b], x[c])) swap(x, result, b);
		else if (comp(x[a], x[c])) swap(x, result, c);
		else swap(x, result, a);
	}
	else if (comp(x[a], x[c])) swap(x, result, a);
	else if (comp(x[b], x[c])) swap(x, result, c);
	else swap(x, result, b);
}

function unguardedPartition<T>(a: Arr<T>, first: number, last: number, pivot: number, comp: Cmp<T>): number {
	while (true) {
		while (comp(a[first], a[pivot])) ++first;
		--last;
		while (comp(a[pivot], a[last])) --last;
		if (!(first < last)) return first;
		swap(a, first, last);
		++first;
	}
}

function finalInsertionSort<T>(a: Arr<T>, first: number, last: number, comp: Cmp<T>): void {
	if (last - first > THRESHOLD) {
		insertionSort(a, first, first + THRESHOLD, comp);
		for (let i = first + THRESHOLD; i !== last; ++i) unguardedLinearInsert(a, i, comp);
	}
	else insertionSort(a, first, last, comp);
}

function insertionSort<T>(a: Arr<T>, first: number, last: number, comp: Cmp<T>): void {
	if (first === last) return;
	for (let i = first + 1; i !== last; ++i) {
		if (comp(a[i], a[first])) {
			const val = a[i];
			for (let k = i; k > first; k--) a[k] = a[k - 1];      // move_backward(first, i, i + 1)
			a[first] = val;
		}
		else unguardedLinearInsert(a, i, comp);
	}
}

function unguardedLinearInsert<T>(a: Arr<T>, last: number, comp: Cmp<T>): void {
	const val = a[last];
	let next = last - 1;
	while (comp(val, a[next])) {
		a[last] = a[next];
		last = next;
		--next;
	}
	a[last] = val;
}

function partialSort<T>(a: Arr<T>, first: number, middle: number, last: number, comp: Cmp<T>): void {
	heapSelect(a, first, middle, last, comp);
	sortHeap(a, first, middle, comp);
}

function heapSelect<T>(a: Arr<T>, first: number, middle: number, last: number, comp: Cmp<T>): void {
	makeHeap(a, first, middle, comp);
	for (let i = middle; i < last; ++i)
		if (comp(a[i], a[first])) popHeap(a, first, middle, i, comp);
}

function makeHeap<T>(a: Arr<T>, first: number, last: number, comp: Cmp<T>): void {
	if (last - first < 2) return;
	const len = last - first;
	let parent = Math.trunc((len - 2) / 2);
	while (true) {
		const value = a[first + parent];
		adjustHeap(a, first, parent, len, value, comp);
		if (parent === 0) return;
		parent--;
	}
}

function popHeap<T>(a: Arr<T>, first: number, last: number, result: number, comp: Cmp<T>): void {
	const value = a[result];
	a[result] = a[first];
	adjustHeap(a, first, 0, last - first, value, comp);
}

function sortHeap<T>(a: Arr<T>, first: number, last: number, comp: Cmp<T>): void {
	while (last - first > 1) {
		--last;
		popHeap(a, first, last, last, comp);
	}
}

function adjustHeap<T>(a: Arr<T>, first: number, hole: number, len: number, value: T, comp: Cmp<T>): void {
	const top = hole;
	let second = hole;
	const half = Math.trunc((len - 1) / 2);
	while (second < half) {
		second = 2 * (second + 1);
		if (comp(a[first + second], a[first + (second - 1)])) second--;
		a[first + hole] = a[first + second];
		hole = second;
	}
	if ((len & 1) === 0 && second === Math.trunc((len - 2) / 2)) {
		second = 2 * (second + 1);
		a[first + hole] = a[first + (second - 1)];
		hole = second - 1;
	}
	let parent = Math.trunc((hole - 1) / 2);
	while (hole > top && comp(a[first + parent], value)) {
		a[first + hole] = a[first + parent];
		hole = parent;
		parent = Math.trunc((hole - 1) / 2);
	}
	a[first + hole] = value;
}

function mergeSort<T>(a: Arr<T>, lo: number, hi: number, buf: T[], comp: Cmp<T>): void {
	if (hi - lo < 2) return;
	const mid = lo + Math.trunc((hi - lo) / 2);
	mergeSort(a, lo, mid, buf, comp);
	mergeSort(a, mid, hi, buf, comp);
	let i = lo, j = mid, k = 0;
	while (i < mid && j < hi)
		buf[k++] = comp(a[j], a[i]) ? a[j++] : a[i++];      // take the right one only if strictly less
	while (i < mid) buf[k++] = a[i++];
	while (j < hi) buf[k++] = a[j++];
	for (let t = 0; t < k; t++) a[lo + t] = buf[t];
}

export class StdAlgo {
	/** std::sort(first, last, comp) over a[first..last). */
	static Sort<T>(a: T[], first: L, last: L, comp: (a: T, b: T) => boolean): void {
		const f = Number(first), l = Number(last);
		if (f !== l) {
			introsortLoop(a, f, l, lg(l - f) * 2, comp);
			finalInsertionSort(a, f, l, comp);
		}
	}

	/** std::partial_sort(first, middle, last, comp). */
	static PartialSort<T>(a: T[], first: L, middle: L, last: L, comp: (a: T, b: T) => boolean): void {
		partialSort(a, Number(first), Number(middle), Number(last), comp);
	}

	/** std::stable_sort: any stable sort gives libstdc++'s result. */
	static StableSort<T>(a: T[], first: L, last: L, comp: (a: T, b: T) => boolean): void {
		const f = Number(first), n = Number(last) - f;
		if (n < 2) return;
		const buf = new Array<T>(n);
		mergeSort(a, f, f + n, buf, comp);
	}
}
