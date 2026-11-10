// stdalgo.js - libstdc++'s sorting algorithms, step for step (GCC 13 bits/stl_algo.h and bits/stl_heap.h), as the
// C# Cpp.StdAlgo (cs/runtime/StdAlgo.cs, the specification) has them. std::sort is an introsort and is not stable:
// with equal keys the order it leaves depends on every swap it makes, so the port makes the same ones, and
// std::partial_sort's heap moves are the same too. StableSort is the C# merge sort, comparison for comparison
// (any stable sort gives libstdc++'s result for a strict weak order). Indices are numbers (the C# longs; a
// cpp.L bigint argument is converted); integer divisions truncate toward zero as C#'s do.
// Checked against libstdc++ by tests/stdcheck (sortcheck.mts, containercheck.mts, run_ts.sh).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.





const THRESHOLD = 16;

/** floor(log2(n)) for n >= 1 (63 - lzcnt). */
function lg(n) {
	return n < 4294967296 ? 31 - Math.clz32(n) : 63 - Math.clz32(Math.floor(n / 4294967296));
}

function swap(a, i, j) { const t = a[i]; a[i] = a[j]; a[j] = t; }

function introsortLoop(a, first, last, depth, comp) {
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

function unguardedPartitionPivot(a, first, last, comp) {
	const mid = first + Math.trunc((last - first) / 2);
	moveMedianToFirst(a, first, first + 1, mid, last - 1, comp);
	return unguardedPartition(a, first + 1, last, first, comp);
}

function moveMedianToFirst(x, result, a, b, c, comp) {
	if (comp(x[a], x[b])) {
		if (comp(x[b], x[c])) swap(x, result, b);
		else if (comp(x[a], x[c])) swap(x, result, c);
		else swap(x, result, a);
	}
	else if (comp(x[a], x[c])) swap(x, result, a);
	else if (comp(x[b], x[c])) swap(x, result, c);
	else swap(x, result, b);
}

function unguardedPartition(a, first, last, pivot, comp) {
	while (true) {
		while (comp(a[first], a[pivot])) ++first;
		--last;
		while (comp(a[pivot], a[last])) --last;
		if (!(first < last)) return first;
		swap(a, first, last);
		++first;
	}
}

function finalInsertionSort(a, first, last, comp) {
	if (last - first > THRESHOLD) {
		insertionSort(a, first, first + THRESHOLD, comp);
		for (let i = first + THRESHOLD; i !== last; ++i) unguardedLinearInsert(a, i, comp);
	}
	else insertionSort(a, first, last, comp);
}

function insertionSort(a, first, last, comp) {
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

function unguardedLinearInsert(a, last, comp) {
	const val = a[last];
	let next = last - 1;
	while (comp(val, a[next])) {
		a[last] = a[next];
		last = next;
		--next;
	}
	a[last] = val;
}

function partialSort(a, first, middle, last, comp) {
	heapSelect(a, first, middle, last, comp);
	sortHeap(a, first, middle, comp);
}

function heapSelect(a, first, middle, last, comp) {
	makeHeap(a, first, middle, comp);
	for (let i = middle; i < last; ++i)
		if (comp(a[i], a[first])) popHeap(a, first, middle, i, comp);
}

function makeHeap(a, first, last, comp) {
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

function popHeap(a, first, last, result, comp) {
	const value = a[result];
	a[result] = a[first];
	adjustHeap(a, first, 0, last - first, value, comp);
}

function sortHeap(a, first, last, comp) {
	while (last - first > 1) {
		--last;
		popHeap(a, first, last, last, comp);
	}
}

function adjustHeap(a, first, hole, len, value, comp) {
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

function mergeSort(a, lo, hi, buf, comp) {
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
	static Sort(a, first, last, comp) {
		const f = Number(first), l = Number(last);
		if (f !== l) {
			introsortLoop(a, f, l, lg(l - f) * 2, comp);
			finalInsertionSort(a, f, l, comp);
		}
	}

	/** std::partial_sort(first, middle, last, comp). */
	static PartialSort(a, first, middle, last, comp) {
		partialSort(a, Number(first), Number(middle), Number(last), comp);
	}

	/** std::stable_sort: any stable sort gives libstdc++'s result. */
	static StableSort(a, first, last, comp) {
		const f = Number(first), n = Number(last) - f;
		if (n < 2) return;
		const buf = new Array(n);
		mergeSort(a, f, f + n, buf, comp);
	}
}
// (ts/src/cpp/stdalgo.ts without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)
