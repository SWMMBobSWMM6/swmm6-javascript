// CRuntime.ts - runtime part C (cs/runtime/CRuntime.cs and Stash.cs): the C runtime layer of the TypeScript SWMM6
// engine, C# Cpp.R and Cpp.CFile. The C library functions of cs/runtime/Fs.cs (the rest of the C# partial class R)
// are class RFs (rfs.ts); R forwards its members of those names to RFs, so the engine's cpp.R.getenv,
// cpp.R.stderr_, ... resolve. It reproduces glibc and x86-64 behaviour byte for byte where the engine's output
// depends on it: printf formatting (exact decimal expansion, rounded half to even on the binary value as glibc does in
// its default rounding mode, and %a), strtod / sscanf parsing (with %n, scan sets and assignment suppression),
// NUL-terminated byte strings, stdio files with C's positioning and end-of-file rules (Node's synchronous fs API),
// and the stash through which sscanf fills pointer parameters (R.Slot, R.Back).
// Sources: the C# runtime is the specification; the code follows the Java port of this runtime (java/src/cpp/R.java,
// CFile.java), which passed all 480 gate models, and the SWMM5 TypeScript port's crt.ts (the toFixed / toExponential
// fast paths of printf). Where the C# departs from glibc in a case the gate does not exercise, this file does what
// glibc does, as the Go and Java ports do (the C# engine is gated byte-identical to the C++ one, so glibc is the
// specification there); each such place says so.
// Values follow ts/RUNTIME_HELPERS.md: long and ulong results are numbers when they are safe integers, bigints
// otherwise. A C string is cpp.CPtr (a_str.ts: B the bytes, O the offset): bytes are read as B[i] & 255 (B may be a
// Uint8Array or a number array holding signed or unsigned bytes) and written directly when B is a Uint8Array, else
// through CPtr.set (the low byte).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.
import * as fs from 'node:fs';
import * as cpp from './index.js';
import { SysException } from './Misc.js';

type L = number | bigint;
type ByteArr = Uint8Array | number[];
type CPtr = cpp.CPtr;

// ------------------------------------------------------------------------------------------------ small helpers

const SAFE = 9007199254740991;
const F64 = new Float64Array(1);
const W32 = new Uint32Array(F64.buffer);          // little-endian: W32[0] low word, W32[1] high word
const F32 = new Float32Array(1);
const W32f = new Uint32Array(F32.buffer);

/** A canonical long from a bigint (wrapped to 64 bits). */
function canonL(b: bigint): L {
	const r = BigInt.asIntN(64, b);
	return r >= -9007199254740991n && r <= 9007199254740991n ? Number(r) : r;
}
/** A canonical ulong from a bigint (wrapped to 64 bits). */
function canonUL(b: bigint): L {
	const r = BigInt.asUintN(64, b);
	return r <= 9007199254740991n ? Number(r) : r;
}
function subL(a: L, b: L): L {
	if (typeof a === 'number' && typeof b === 'number') {
		const r = a - b;
		if (r >= -SAFE && r <= SAFE) return r === 0 ? 0 : r;
	}
	return canonL(BigInt(a) - BigInt(b));
}
/** The low 32 bits of a long as an int. */
function toI32(x: L): number { return typeof x === 'number' ? x | 0 : Number(BigInt.asIntN(32, x)); }
/** x86-64 cvttsd2si to a long: NaN and out-of-range values give the "integer indefinite" value -2^63. */
function d2l(x: number): L {
	if (!(x >= -9223372036854775808 && x < 9223372036854775808)) return -9223372036854775808n;
	const t = Math.trunc(x);
	return t >= -SAFE && t <= SAFE ? t + 0 : BigInt(t);
}
function isSpace(c: number): boolean { return c === 32 || (c >= 9 && c <= 13); }
function isDig(c: number): boolean { return c >= 48 && c <= 57; }
function isHex(c: number): boolean { return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
function low(c: number): number { return c >= 65 && c <= 90 ? c | 0x20 : c; }
function hexVal(c: number): number { return c <= 57 ? c - 48 : (c | 0x20) - 87; }

/** The Latin-1 string of n bytes of B from i. */
function latin1(B: ByteArr, i: number, n: number): string {
	let s = '';
	if (B instanceof Uint8Array) {
		for (let k = 0; k < n; k += 8192) s += String.fromCharCode.apply(null, B.subarray(i + k, i + Math.min(n, k + 8192)) as any);
		return s;
	}
	for (let k = 0; k < n; k++) s += String.fromCharCode(B[i + k] & 255);
	return s;
}
function newCPtr(b: ByteArr, o: number): CPtr { return new cpp.CPtr(b as any, o); }
function nullCPtr(): CPtr { return cpp.CPtr.ZERO; }
/** Byte v (0..255) into the C string p at absolute index i of p.B. */
function setByte(p: CPtr, i: number, v: number): void {
	const B: any = p.B;
	if (B instanceof Uint8Array) B[i] = v;
	else p.set(i - p.O, v);
}
/** n bytes of src from s0 into the C string p at absolute index i of p.B. */
function setBytes(p: CPtr, i: number, src: ByteArr, s0: number, n: number): void {
	const B: any = p.B;
	if (B instanceof Uint8Array && src instanceof Uint8Array) {
		if (src === B) B.copyWithin(i, s0, s0 + n);
		else B.set(src.subarray(s0, s0 + n), i);
		return;
	}
	if (src === B) {                       // overlapping: through a copy, as memmove
		const t = Uint8Array.from((src as number[]).slice(s0, s0 + n), (x) => x & 255);
		for (let k = 0; k < n; k++) setByte(p, i + k, t[k]);
		return;
	}
	for (let k = 0; k < n; k++) setByte(p, i + k, src[s0 + k] & 255);
}
function strlenAt(B: ByteArr, i: number): number {
	let e = i;
	while ((B[e] & 255) !== 0) e++;
	return e - i;
}

// ------------------------------------------------------------------------------------------------ C FILE*

const BUFSZ = 1 << 16;

/** The C# Stream under a CFile (CFile.S), with the members the C# runtime calls: Write, Read, ReadByte, Flush,
 *  Seek (C's whence: 0 SEEK_SET, 1 SEEK_CUR, 2 SEEK_END), Position, Length, Dispose. A file is a descriptor with a
 *  64 KiB write buffer and read buffer and its own position (the scheme of the Java port's CFile.Stream), which
 *  behaves as the C# FileStream + BufferedStream does: reads, writes and seeks interleave freely and the position is
 *  the logical one. A standard output stream writes through to its descriptor at once, as C#'s Console streams do;
 *  a standard input stream reads from its descriptor. The null stream (C#'s Stream.Null, under a directory that
 *  fopen opened) reads nothing, discards what is written and is always at position 0. */
export class CFileStream {
	fd: number;
	kind: number;                     // 0 a file, 1 a standard output stream, 2 a standard input stream, 3 null
	pos = 0;
	floor = 0;                        // append mode: no seeking before the length at open (.NET's FileMode.Append)
	wbuf: Uint8Array = null; wlen = 0; wpos = 0;
	rbuf: Uint8Array = null; rstart = 0; rlen = 0;
	closed = false;
	constructor(fd: number, kind: number) { this.fd = fd; this.kind = kind; }
	/** A file opened with fs.openSync. */
	static file(fd: number): CFileStream { return new CFileStream(fd, 0); }
	/** A standard output stream (1 stdout, 2 stderr), written through. */
	static stdOut(fd: number): CFileStream { return new CFileStream(fd, 1); }
	/** A standard input stream (0 stdin). */
	static stdIn(fd: number): CFileStream { return new CFileStream(fd, 2); }
	/** C#'s Stream.Null: no descriptor; reads return 0 bytes, writes are discarded, Seek and Length are 0. */
	static nul(): CFileStream { return new CFileStream(-1, 3); }

	Flush(): void {
		if (this.kind !== 0 || this.wlen === 0) return;
		writeAll(this.fd, this.wbuf, 0, this.wlen, this.wpos);
		this.wlen = 0;
	}

	/** n bytes of src (a Uint8Array, or a number array of byte values) from off. */
	Write(src: ByteArr, off: number, n: number): void {
		if (n <= 0 || this.kind === 3) return;
		let s: Uint8Array, so = off;
		if (src instanceof Uint8Array) s = src;
		else { s = new Uint8Array(n); for (let k = 0; k < n; k++) s[k] = src[off + k] & 255; so = 0; }
		if (this.kind === 1) { writeAll(this.fd, s, so, n, null); this.pos += n; return; }
		if (this.kind !== 0) throw new SysException('NotSupportedException', 'Stream does not support writing.');
		if (this.closed) throw new SysException('ObjectDisposedException', 'Cannot access a closed file.');
		this.rlen = 0;
		if (this.wbuf === null) this.wbuf = new Uint8Array(BUFSZ);
		if (this.wlen > 0 && this.pos !== this.wpos + this.wlen) this.Flush();
		if (this.wlen === 0) this.wpos = this.pos;
		if (this.wlen + n > BUFSZ) {
			this.Flush();
			if (n > BUFSZ) {
				writeAll(this.fd, s, so, n, this.pos);
				this.pos += n;
				return;
			}
			this.wpos = this.pos;
		}
		this.wbuf.set(s.subarray(so, so + n), this.wlen);
		this.wlen += n;
		this.pos += n;
	}

	/** Up to n bytes into dst at off; the number read, 0 at the end. */
	Read(dst: Uint8Array, off: number, n: number): number {
		if (n <= 0 || this.kind === 3) return 0;
		if (this.kind === 2) {
			let got = 0;
			while (got < n) {
				let r: number;
				try { r = fs.readSync(this.fd, dst, off + got, n - got, null); }
				catch (e) { if (e && e.code === 'EAGAIN') continue; if (e && e.code === 'EOF') r = 0; else throw e; }
				if (r <= 0) break;
				got += r;
			}
			this.pos += got;
			return got;
		}
		if (this.kind !== 0) throw new SysException('NotSupportedException', 'Stream does not support reading.');
		if (this.closed) throw new SysException('ObjectDisposedException', 'Cannot access a closed file.');
		this.Flush();
		let got = 0;
		while (got < n) {
			if (this.rlen > 0 && this.pos >= this.rstart && this.pos < this.rstart + this.rlen) {
				const a = this.pos - this.rstart;
				const m = Math.min(n - got, this.rlen - a);
				dst.set(this.rbuf.subarray(a, a + m), off + got);
				got += m;
				this.pos += m;
				continue;
			}
			if (this.rbuf === null) this.rbuf = new Uint8Array(BUFSZ);
			this.rstart = this.pos;
			const r = fs.readSync(this.fd, this.rbuf, 0, BUFSZ, this.pos);
			this.rlen = r < 0 ? 0 : r;
			if (this.rlen === 0) break;
		}
		return got;
	}

	/** The next byte (0..255), or -1 at the end. */
	ReadByte(): number {
		if (this.kind === 0 && this.wlen === 0 && this.rlen > 0 && this.pos >= this.rstart && this.pos < this.rstart + this.rlen)
			return this.rbuf[this.pos++ - this.rstart];
		const t = ONE;
		return this.Read(t, 0, 1) === 1 ? t[0] : -1;
	}

	get Length(): number {
		if (this.kind === 3) return 0;
		if (this.kind !== 0) throw new SysException('NotSupportedException', 'Stream does not support seeking.');
		this.Flush();
		return fs.fstatSync(this.fd).size;
	}

	/** The new position; throws for a negative one or one before an append's start (as .NET's FileStream.Seek
	 *  throws IOException), and on a standard stream (NotSupportedException). */
	Seek(off: L, whence: number): number {
		if (this.kind === 3) return 0;
		if (this.kind !== 0) throw new SysException('NotSupportedException', 'Stream does not support seeking.');
		this.Flush();
		const o = Number(off);
		const p = whence === 0 ? o : whence === 1 ? this.pos + o : this.Length + o;
		if (p < this.floor) throw new SysException('IOException', p < 0 ? 'An attempt was made to move the position before the beginning of the stream.'
			: 'Unable to seek backward to overwrite data that previously existed in a file opened in Append mode.');
		this.pos = p;
		return p;
	}

	get Position(): number { return this.pos; }

	Dispose(): void {
		if (this.closed) return;
		try { this.Flush(); }
		finally {
			if (this.kind === 0) { this.closed = true; fs.closeSync(this.fd); }
		}
	}
}
const ONE = new Uint8Array(1);

/** Write n bytes of b from off to the descriptor (at position pos, or the current offset when pos is null), all of
 *  them, retrying when a non-blocking descriptor is momentarily full. */
function writeAll(fd: number, b: Uint8Array, off: number, n: number, pos: number | null): void {
	while (n > 0) {
		let w: number;
		try { w = fs.writeSync(fd, b, off, n, pos); }
		catch (e) { if (e && e.code === 'EAGAIN') continue; throw e; }
		off += w; n -= w;
		if (pos !== null) pos += w;
	}
}

/** C FILE* (C# Cpp.CFile): a stream with C's end-of-file flag, and the registry of the files fopen opened, which
 *  C's exit() flushes (R.FlushAll). */
export class CFile {
	S: CFileStream;
	Eof = false;
	/** A directory opened with fopen(dir, "r"): glibc opens it, and every read then fails with EISDIR, which sets
	 *  the error indicator (Err), not end-of-file (C# Cpp.CFile.Dir). */
	Dir = false;
	Err = false;
	IsStd: boolean;
	constructor(s: CFileStream, std: boolean = false) {
		this.S = s;
		this.IsStd = std;
		if (!std) CFile.Open.add(this);
	}
	/** A read found no more data: end-of-file, or for a directory an error. */
	ReadFailed(): void { if (this.Dir) this.Err = true; else this.Eof = true; }
	/** The files fopen opened and fclose has not closed: exit() flushes them (R.FlushAll). */
	static Open: Set<CFile> = new Set<CFile>();
}

// ------------------------------------------------------------------------------------------------ sscanf targets

/** An int lvalue passed to sscanf (C# Cpp.RefI): the setter stores the value scanned. */
export class ScanSetI { Set: (v: number) => void; constructor(a: (v: number) => void) { this.Set = a; } }
/** A long lvalue passed to sscanf (C# Cpp.RefL). */
export class ScanSetL { Set: (v: L) => void; constructor(a: (v: L) => void) { this.Set = a; } }
/** A double lvalue passed to sscanf (C# Cpp.RefD). */
export class ScanSetD { Set: (v: number) => void; constructor(a: (v: number) => void) { this.Set = a; } }
/** A float lvalue passed to sscanf (C# Cpp.RefF). */
export class ScanSetF { Set: (v: number) => void; constructor(a: (v: number) => void) { this.Set = a; } }
/** The type of R.Slot (C# Cpp.ScanSlot, Stash.cs): a sscanf target that is a C pointer parameter of the calling
 *  function; the value scanned is stashed and R.Back copies it into the parameter. */
export class ScanSlot { }

// The stash (Stash.cs): each value with the C type glibc stores it as: i int, u unsigned, l long, ul unsigned long,
// f float, d double, c char (the first byte of a %c)
let stashK: string[] = [];
let stashV: L[] = [];
function stashReset(): void { stashK.length = 0; stashV.length = 0; }
function stash(k: string, v: L): void { stashK.push(k); stashV.push(v); }

const RANGE: { [k: string]: [bigint, bigint] } = {
	i: [-2147483648n, 2147483647n], u: [0n, 4294967295n], l: [-9223372036854775808n, 9223372036854775807n],
	ul: [0n, 18446744073709551615n], s: [-32768n, 32767n], us: [0n, 65535n], c: [-128n, 127n], uc: [0n, 255n],
	ch: [0n, 65535n],
};
const TYPE_NAME: { [k: string]: string } = {
	i: 'Int32', u: 'UInt32', l: 'Int64', ul: 'UInt64', s: 'Int16', us: 'UInt16', c: 'SByte', uc: 'Byte', ch: 'Char',
};
/** .NET's rounding of a double to an integer in Convert: half to even. */
function rintEven(x: number): number {
	const r = Math.round(x);
	return (r - x === 0.5 && r % 2 !== 0) ? r - 1 : r;
}
/** Convert.ChangeType(stashed value, T) for T's code: checked, as .NET's Convert is (OverflowException outside T's
 *  range; a floating value is rounded half to even first; char from a floating value is an InvalidCastException). */
function convertTo(code: string, k: string, v: L): any {
	const fl = k === 'f' || k === 'd';
	switch (code) {
		case 'f': return Math.fround(Number(v));
		case 'd': return Number(v);
		case 'b': return typeof v === 'bigint' ? v !== 0n : v !== 0;
	}
	const rg = RANGE[code];
	if (!rg) throw new SysException('InvalidCastException', 'Invalid cast to type code ' + code + '.');
	if (fl && code === 'ch') throw new SysException('InvalidCastException', "Invalid cast from '" + (k === 'f' ? 'Single' : 'Double') + "' to 'Char'.");
	let x: bigint;
	if (fl) {
		const d = Number(v);
		if (d !== d) throw new SysException('OverflowException', 'Value was either too large or too small for an ' + TYPE_NAME[code] + '.');
		const r = rintEven(d);
		if (!(r >= -1.8446744073709552e19 && r <= 1.8446744073709552e19)) throw new SysException('OverflowException', 'Value was either too large or too small for an ' + TYPE_NAME[code] + '.');
		x = BigInt(r);
	} else x = BigInt(v);
	if (x < rg[0] || x > rg[1]) throw new SysException('OverflowException', 'Value was either too large or too small for an ' + TYPE_NAME[code] + '.');
	return code === 'l' ? canonL(x) : code === 'ul' ? canonUL(x) : Number(x);
}
/** Stash.cs's Take<T>(i, ref a): the i'th stashed value converted to T, when there is one. */
function take(i: number, code: string, a: cpp.Ref<any>): void {
	if (i < stashK.length) a.set(convertTo(code, stashK[i], stashV[i]));
}

// ------------------------------------------------------------------------------------------------ strtod internals

const DEFAULT_NAN = (() => { W32[1] = 0xfff80000; W32[0] = 0; return F64[0]; })();   // x86's NaN: negative
const POS_NAN = (() => { W32[1] = 0x7ff80000; W32[0] = 0; return F64[0]; })();

// scanDouble's results besides the value: the end index (-1: no number), what it read, and the text of the number
// (made only when it is needed: scanTextOf)
let scanEnd = -1;
let scanKind = 0;                              // 0 nothing, 1 a decimal number, 2 a hexadecimal one, 3 inf or nan
let scanHex: string = null;                    // a hexadecimal number's text
let scanB: ByteArr = null, scanS = 0, scanNeg = false;   // a decimal number: b[scanS..scanEnd) after its sign
let scanNanPayload: bigint = -1n;              // for a nan(n-char-sequence): its payload (-1: none)
/** Whether the last scanDouble (strtod, atof, sscanf's conversions) would have set errno to ERANGE in glibc: an
 *  overflow to +-inf, a nonzero number that became zero, or a result that is tiny (below DBL_MIN after rounding to
 *  53 bits, the x86 rule) and inexact (R.ERange; C# Cpp.R.ERange, java/src/cpp/R.java ERange). libstdc++'s
 *  std::stod throws out_of_range on it. */
let scanRange = false;
/** The text of the number scanDouble read last ("[-]digits[.digits][e[+-]digits]" or "[-]0xMANTpEXP"), null for
 *  inf, nan or nothing. */
function scanTextOf(): string {
	if (scanKind === 2) return scanHex;
	if (scanKind === 1) return (scanNeg ? '-' : '') + latin1(scanB, scanS, scanEnd - scanS);
	return null;
}

function g(b: ByteArr, lim: number, k: number): number { return k < lim ? (b[k] & 255) : 0; }

/** glibc's strtod on b[i..] (at most maxw characters when maxw >= 0; the array's end or a NUL ends the input).
 *  Sets scanEnd and scanKind. A decimal number of at most 15 significant digits and a power of ten within 10^22 is
 *  m * 10^e or m / 10^-e, one correctly rounded operation on exact operands (Clinger's fast path); any other decimal
 *  text is converted by Number(), which is correctly rounded as glibc's strtod is; hexadecimal floats exactly;
 *  inf/infinity and nan / nan(n-char-sequence) as glibc reads them. */
function scanDouble(b: ByteArr, i: number, maxw: number, skipSpace: boolean): number {
	scanRange = false;
	const n = b.length;
	if (skipSpace) while (i < n && isSpace(b[i] & 255)) i++;
	const lim = maxw >= 0 && i + maxw < n ? i + maxw : n;
	let neg = false;
	scanNanPayload = -1n;
	if (g(b, lim, i) === 43 || g(b, lim, i) === 45) { neg = g(b, lim, i) === 45; i++; }
	if (low(g(b, lim, i)) === 105 && low(g(b, lim, i + 1)) === 110 && low(g(b, lim, i + 2)) === 102) {
		i += 3;
		if (low(g(b, lim, i)) === 105 && low(g(b, lim, i + 1)) === 110 && low(g(b, lim, i + 2)) === 105
			&& low(g(b, lim, i + 3)) === 116 && low(g(b, lim, i + 4)) === 121) i += 5;
		scanEnd = i; scanKind = 3;
		return neg ? -Infinity : Infinity;
	}
	if (low(g(b, lim, i)) === 110 && low(g(b, lim, i + 1)) === 97 && low(g(b, lim, i + 2)) === 110) {
		i += 3;
		if (g(b, lim, i) === 40) {
			let k = i + 1;
			for (;; k++) {
				const c = g(b, lim, k);
				if (!(isDig(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) break;
			}
			if (g(b, lim, k) === 41) {
				// glibc reads the n-char-sequence with strtoull(seq, 0) and keeps it as the payload
				const pl = k === i + 1 ? 0n : parseCUnsigned(latin1(b, i + 1, k - i - 1));
				if (pl !== null) {
					scanNanPayload = pl;
					F64[0] = 0; W32[1] = 0x7ff80000 | Number((pl >> 32n) & 0x7ffffn); W32[0] = Number(pl & 0xffffffffn);
					let v = F64[0];
					if (neg) { W32[1] = (W32[1] | 0x80000000) >>> 0; v = F64[0]; }
					scanEnd = k + 1; scanKind = 3;
					return v;
				}
				i = k + 1;
			}
		}
		scanEnd = i; scanKind = 3;
		return neg ? DEFAULT_NAN : POS_NAN;
	}
	if (g(b, lim, i) === 48 && low(g(b, lim, i + 1)) === 120) {       // hexadecimal float (C99), as glibc reads it
		let j = i + 2, nh = 0;
		while (isHex(g(b, lim, j))) { j++; nh++; }
		if (g(b, lim, j) === 46) { j++; while (isHex(g(b, lim, j))) { j++; nh++; } }
		if (nh > 0) {
			const mant = latin1(b, i + 2, j - i - 2);
			let exp = '0';
			if (low(g(b, lim, j)) === 112) {
				let k = j + 1;
				if (g(b, lim, k) === 43 || g(b, lim, k) === 45) k++;
				if (isDig(g(b, lim, k))) {
					while (isDig(g(b, lim, k))) k++;
					exp = latin1(b, j + 1, k - j - 1);
					j = k;
				}
			}
			const text = (neg ? '-' : '') + '0x' + mant + 'p' + exp;
			scanEnd = j; scanKind = 2; scanHex = text;
			const hv = parseHex(text, false);
			// (a hexadecimal subnormal is not checked)
			scanRange = (hv === 0 && /[1-9a-fA-F]/.test(mant)) || hv === Infinity || hv === -Infinity;
			return hv;
		}
	}
	const ms = i;
	let nd = 0, m = 0, sig = 0, frac = 0, exact = true, c: number;
	while (isDig(c = g(b, lim, i))) {
		nd++; i++;
		if (sig > 0 || c !== 48) { if (sig < 15) m = m * 10 + (c - 48); else exact = false; sig++; }
	}
	if (c === 46) {
		i++;
		while (isDig(c = g(b, lim, i))) {
			nd++; i++; frac++;
			if (sig > 0 || c !== 48) { if (sig < 15) m = m * 10 + (c - 48); else exact = false; sig++; }
		}
	}
	if (nd === 0) { scanEnd = -1; scanKind = 0; return 0; }
	let e10 = 0;
	if (low(c) === 101) {
		let k = i + 1, en = false;
		const sc = g(b, lim, k);
		if (sc === 43 || sc === 45) { en = sc === 45; k++; }
		if (isDig(g(b, lim, k))) {
			for (let d: number; isDig(d = g(b, lim, k)); k++) if (e10 < 100000) e10 = e10 * 10 + (d - 48);
			if (en) e10 = -e10;
			i = k;
		}
	}
	scanEnd = i; scanKind = 1; scanB = b; scanS = ms; scanNeg = neg;
	if (exact) {
		const E = e10 - frac;
		let v = -1;
		if (m === 0) v = 0;
		else if (E >= 0 && E <= 22) v = m * P10[E];
		else if (E < 0 && E >= -22) v = m / P10[-E];
		// never ERANGE (decRange is false): a zero here is an exact zero, and any other value is m * 10^E with
		// 0 < m < 10^15 and |E| <= 22, so finite and at least 10^-22, far above DBL_MIN
		if (v >= 0) return neg ? -v : v;
	}
	const dv = parseDec(scanTextOf());
	scanRange = decRange(latin1(b, ms, i - ms), Math.abs(dv));
	return dv;
}

const DBL_MIN = 2.2250738585072014e-308;
/** 2^54 - 1: (2^54 - 1) * 2^-1076 = 2^-1022 - 2^-1076, the midpoint under DBL_MIN of the 53-bit grid. */
const LIM54 = (1n << 54n) - 1n;
/** glibc strtod's ERANGE for the decimal text txt (digits, '.', exponent; no sign) whose correctly rounded value is
 *  av: overflow, or underflow (tiny after rounding and inexact, decided exactly), as C# R.DecRange and Java
 *  R.decRange decide it. */
function decRange(txt: string, av: number): boolean {
	if (av === Infinity) return true;
	if (av > DBL_MIN) return false;                              // above DBL_MIN: normal
	const len = txt.length;
	let k = 0, e10 = 0;
	while (k < len && isDig(txt.charCodeAt(k))) k++;
	let digs = txt.slice(0, k);
	if (k < len && txt.charCodeAt(k) === 46) {
		const s = ++k;
		while (k < len && isDig(txt.charCodeAt(k))) k++;
		digs += txt.slice(s, k);
		e10 -= k - s;
	}
	const d = BigInt(digs.length > 0 ? digs : '0');
	if (d === 0n) return false;                                  // a zero is exact
	if (k < len && low(txt.charCodeAt(k)) === 101) {
		k++;
		let en = false;
		if (k < len && (txt.charCodeAt(k) === 43 || txt.charCodeAt(k) === 45)) { en = txt.charCodeAt(k) === 45; k++; }
		let ex = 0;
		for (; k < len && isDig(txt.charCodeAt(k)); k++) ex = Math.min(ex * 10 + (txt.charCodeAt(k) - 48), 1000000000);
		e10 += en ? -ex : ex;
	}
	const nd = d.toString().length;
	if (nd + e10 < -340) return true;                            // below 1e-340: zero, and not exact
	if (e10 >= 0) return false;
	const p10 = 10n ** BigInt(-e10);                             // the value is d / 10^-e10
	// tiny after rounding: below 2^-1022 - 2^-1076, the midpoint under DBL_MIN of the 53-bit grid
	if ((d << 1076n) >= LIM54 * p10) return false;
	// inexact: not av itself, which is m * 2^-1074 for a subnormal (or DBL_MIN, or zero)
	F64[0] = av;
	const m = (BigInt(W32[1]) << 32n) | BigInt(W32[0]);
	return (d << 1074n) !== m * p10;
}

/** strtoull(s, 0, 0) of a whole n-char-sequence: decimal, 0x hexadecimal or 0 octal; null when it is not one (or
 *  out of range). */
function parseCUnsigned(s: string): bigint {
	let r: bigint;
	if (/^0[xX][0-9a-fA-F]+$/.test(s)) r = BigInt('0x' + s.slice(2));
	else if (/^0[0-7]*$/.test(s)) r = s.length > 1 ? BigInt('0o' + s.slice(1)) : 0n;
	else if (/^[1-9][0-9]*$/.test(s)) r = BigInt(s);
	else return null;
	return r > 18446744073709551615n ? null : r;
}

/** A decimal floating text "[-]digits[.digits][e[+-]digits]" as strtod converts it (correctly rounded; a huge
 *  exponent clamped, which cannot change the result). */
function parseDec(text: string): number { return Number(clampExp(text)); }
function clampExp(text: string): string {
	let e = text.indexOf('e');
	if (e < 0) e = text.indexOf('E');
	if (e < 0 || text.length - e < 8) return text;
	let k = e + 1;
	let en = false;
	if (text[k] === '+' || text[k] === '-') { en = text[k] === '-'; k++; }
	const digs = text.slice(k).replace(/^0+/, '');
	if (digs.length <= 6) return text;
	return text.slice(0, e) + (en ? 'e-999999' : 'e999999');
}

/** strtof of the decimal number scanDouble read last, whose correctly rounded double is d: correctly rounded to float
 *  (glibc's strtof; the C# rounds the double, which can differ when the double is exactly halfway between two
 *  floats: then the text decides). */
function parseDecF(d: number): number {
	const f = Math.fround(d);
	if (f === d || d !== d || d === Infinity || d === -Infinity) return f;
	// d lies strictly between two floats: only when it is exactly their midpoint can the double rounding differ
	const ad = Math.abs(d), af = Math.abs(f);
	let other: number;
	if (af === Infinity) other = 3.4028234663852886e38;
	else {
		F32[0] = af;
		W32f[0] = af < ad ? W32f[0] + 1 : W32f[0] - 1;
		other = F32[0];
	}
	const lo = Math.min(af, other), hi = Math.max(af, other);
	const mid = hi === Infinity ? 3.4028235677973366e38 : (lo + hi) / 2;
	if (ad !== mid) return f;
	const c = cmpDecimal(scanTextOf(), mid);
	if (c === 0) return f;                                     // an exact tie: fround already rounded it to even
	const r = c > 0 ? hi : lo;
	return d < 0 ? -r : r;
}

/** The sign of |decimal text| - x, exactly (x > 0 finite). */
function cmpDecimal(text: string, x: number): number {
	const m = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
	const ip = m[1] || '', fp = m[2] || '';
	let e10 = (m[3] ? parseInt(m[3], 10) : 0) - fp.length;
	const D = BigInt((ip + fp).replace(/^0+(?=\d)/, '') || '0');
	const [M, e2] = decompose(x);
	let lhs = D, rhs = M;
	if (e10 >= 0) lhs *= pow10n(e10); else rhs *= pow10n(-e10);
	if (e2 >= 0) rhs <<= BigInt(e2); else lhs <<= BigInt(-e2);
	return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
}

/** A hexadecimal floating text "[-]0xMANT.FRACpEXP" rounded once to a double (or a float), as strtod (strtof). */
function parseHex(text: string, toFloat: boolean): number {
	let k = 0, neg = false;
	if (text[0] === '-') { neg = true; k = 1; }
	k += 2;
	const p = text.indexOf('p');
	const mant = text.slice(k, p);
	const dot = mant.indexOf('.');
	const digs = dot < 0 ? mant : mant.slice(0, dot) + mant.slice(dot + 1);
	const fracDigits = dot < 0 ? 0 : mant.length - dot - 1;
	let es = text.slice(p + 1);
	let en = false;
	if (es[0] === '+' || es[0] === '-') { en = es[0] === '-'; es = es.slice(1); }
	es = es.replace(/^0+(?=\d)/, '');
	let e = es.length > 7 ? 99999999 : parseInt(es, 10);
	if (en) e = -e;
	const m = BigInt('0x' + (digs.replace(/^0+(?=.)/, '') || '0'));
	const v = m === 0n ? 0 : roundBin(m, e - 4 * fracDigits, toFloat ? 24 : 53, toFloat ? -126 : -1022, toFloat ? 127 : 1023);
	return neg ? -v : v;
}

function bitlen(n: bigint): number { return n === 0n ? 0 : n.toString(2).length; }
/** 2^k as a double, -1074 <= k <= 1023. */
function pow2(k: number): number {
	F64[0] = 0;
	if (k >= -1022) { W32[1] = (k + 1023) << 20; W32[0] = 0; }
	else if (k >= -1042) { W32[1] = 1 << (k + 1042); W32[0] = 0; }
	else { W32[1] = 0; W32[0] = (2 ** (k + 1074)) >>> 0; }
	return F64[0];
}
/** m * 2^e2 (m > 0) rounded once (half to even) to a binary format with p significant bits and exponents
 *  emin..emax (subnormals below emin): the double, or float, value as a JavaScript number. */
function roundBin(m: bigint, e2: number, p: number, emin: number, emax: number): number {
	const n = bitlen(m);
	const E = n - 1 + e2;                         // the exponent of the leading bit
	if (E > emax + 1) return Infinity;
	const lsb = Math.max(E - p + 1, emin - p + 1);
	const shift = lsb - e2;
	let q: bigint;
	if (shift <= 0) q = m << BigInt(-shift);
	else if (shift > n) return 0;                 // below half the smallest unit: rounds to zero
	else {
		const sh = BigInt(shift);
		q = m >> sh;
		const rem = m & ((1n << sh) - 1n), half = 1n << (sh - 1n);
		if (rem > half || (rem === half && (q & 1n) === 1n)) q += 1n;
	}
	if (q === 0n) return 0;
	if (lsb + bitlen(q) - 1 > emax) return Infinity;
	// q has at most p + 1 bits (<= 2^53) and lsb >= -1074: the product is exact
	return Number(q) * pow2(lsb);
}

/** x = M * 2^e exactly (x > 0 finite; M an integer). */
function decompose(x: number): [bigint, number] {
	F64[0] = x;
	const hi = W32[1], lo = W32[0];
	const ex = (hi >>> 20) & 0x7ff;
	let M = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
	if (ex === 0) return [M, -1074];
	M |= 1n << 52n;
	return [M, ex - 1075];
}

const P10N: bigint[] = [];
function pow10n(k: number): bigint {
	if (k < 400) {
		let r = P10N[k];
		if (r === undefined) { r = 10n ** BigInt(k); P10N[k] = r; }
		return r;
	}
	return 10n ** BigInt(k);
}

// ------------------------------------------------------------------------------------------------ sscanf internals

let stW = 0, stP = 0;                // scanFloat's state: characters still allowed (-1: no limit), next index
let sfLen = 0, sfLast = 0;           // the characters taken so far, and the last one (an exponent marker in lower case)

/** The scanner of glibc's vfscanf for a floating conversion at b[i] (not a space, not the end): it returns the
 *  index after the characters it takes (at most width, 0 for no limit), -1 for a matching failure; the characters
 *  taken are b[i..] up to there. Like glibc, it reads one character ahead and pushes back only that one, so an
 *  exponent marker or sign with no digits after it ("1e", "1e+") is taken (and ignored by the conversion), and a
 *  partial "infinity" or a bare "0x" fails. "nan" never takes an n-char-sequence. */
function scanFloat(b: ByteArr, i: number, width: number): number {
	stW = width === 0 ? -1 : width; stP = i;
	sfLen = 0; sfLast = 0;
	let c = inchar(b);
	dec();
	let gotSign = 0;
	if (c === 45 || c === 43) {
		gotSign = 1;
		sfTake(c);
		if (stW === 0) return -1;
		if ((c = inchar(b)) < 0) return -1;
		dec();
	}
	if (low(c) === 110) {                                   // "nan"
		sfTake(c);
		if (!expect(b, 97) || !expect(b, 110)) return -1;
		return stP;
	}
	if (low(c) === 105) {                                   // "inf" or "infinity"
		sfTake(c);
		if (!expect(b, 110) || !expect(b, 102)) return -1;
		if (stW !== 0) {
			if ((c = inchar(b)) >= 0) {
				if (low(c) === 105) {
					dec();
					sfTake(c);
					if (!expect(b, 110) || !expect(b, 105) || !expect(b, 116) || !expect(b, 121)) return -1;
				} else stP--;                               // ungetc
			}
		}
		return stP;
	}
	let expChar = 101;
	let hexa = false, gotDigit = false, gotDot = false, gotE = false;
	if (stW !== 0 && c === 48) {
		sfTake(48);
		c = inchar(b);
		dec();
		if (stW !== 0 && low(c) === 120) {
			sfTake(c);
			hexa = true;
			expChar = 112;
			c = inchar(b);
			dec();
		} else gotDigit = true;
	}
	for (;;) {
		if (c >= 48 && c <= 57) { sfTake(c); gotDigit = true; }
		else if (!gotE && hexa && isHex(c)) { sfTake(c); gotDigit = true; }
		else if (gotE && sfLast === expChar && (c === 45 || c === 43)) sfTake(c);
		else if (gotDigit && !gotE && low(c) === expChar) { sfTake(expChar); gotE = true; gotDot = true; }
		else if (!gotDot && c === 46) { sfTake(46); gotDot = true; }
		else { if (c >= 0) stP--; break; }               // not part of the number: pushed back
		if (stW === 0) break;
		if ((c = inchar(b)) < 0) break;
		dec();
	}
	if (sfLen === gotSign || (hexa && sfLen === 2 + gotSign)) return -1;
	return stP;
}
function sfTake(c: number): void { sfLen++; sfLast = c; }
function inchar(b: ByteArr): number {
	const p = stP;
	if (p < b.length && (b[p] & 255) !== 0) { stP = p + 1; return b[p] & 255; }
	return -1;                                             // the end of the string is EOF
}
function dec(): void { if (stW > 0) stW--; }
function expect(b: ByteArr, ch: number): boolean {
	if (stW === 0) return false;
	const c = inchar(b);
	if (c < 0 || low(c) !== ch) return false;
	dec();
	sfTake(c);
	return true;
}

/** A float NaN with glibc's strtof payload: the low 22 bits of the n-char-sequence's value. */
function nanF(neg: boolean, payload: bigint): number {
	W32f[0] = (0x7fc00000 | Number(payload & 0x3fffffn)) >>> 0;
	if (neg) W32f[0] = (W32f[0] | 0x80000000) >>> 0;
	return F32[0];
}

function tooFew(): Error { return new SysException('IndexOutOfRangeException', 'sscanf: too few arguments'); }

/** An integer conversion's value into its target: v is the strtol / strtoul result as a canonical long (for %u
 *  the bit pattern glibc stores: 32 bits unless the l modifier was given, then 64 as a long), kind the C type. */
function storeInt(a: any, v: L, lmod: number, unsigned: boolean): void {
	if (a instanceof ScanSetI) a.Set(toI32(v));
	else if (a instanceof ScanSetL) a.Set(v);
	else if (a instanceof ScanSlot) {
		if (lmod > 0) stash(unsigned ? 'ul' : 'l', unsigned ? canonUL(BigInt(v)) : v);
		else stash(unsigned ? 'u' : 'i', unsigned ? (toI32(v) >>> 0) : toI32(v));
	}
	else if (a !== null && a !== undefined && typeof a.set === 'function') a.set(lmod > 0 ? v : toI32(v));
	else throw new SysException('ArgumentException', 'sscanf integer target ' + a);
}
/** A char* target: a C string, or a char array pointer (part A's cpp.Ptr). */
function bufTarget(a: any): CPtr {
	if (a instanceof cpp.CPtr) return a;
	if (a instanceof cpp.Ptr) return cpp.CPtr.from_Ptrc(a as any);
	throw new SysException('ArgumentException', 'sscanf string target ' + a);
}

// ------------------------------------------------------------------------------------------------ printf internals

let OB = new Uint8Array(1024);
let ON = 0;
function need(n: number): void {
	if (ON + n <= OB.length) return;
	let c = OB.length * 2;
	while (c < ON + n) c *= 2;
	const nb = new Uint8Array(c);
	nb.set(OB.subarray(0, ON));
	OB = nb;
}
function outStr(s: string): void {
	const n = s.length;
	need(n);
	for (let i = 0; i < n; i++) OB[ON++] = s.charCodeAt(i);
}
function outPad(c: number, n: number): void {
	if (n <= 0) return;
	need(n);
	OB.fill(c, ON, ON + n);
	ON += n;
}
function outBytes(B: ByteArr, i: number, n: number): void {
	if (n <= 0) return;
	need(n);
	if (B instanceof Uint8Array) OB.set(B.subarray(i, i + n), ON);
	else for (let k = 0; k < n; k++) OB[ON + k] = B[i + k] & 255;
	ON += n;
}

function argAt(args: any[], i: number): any {
	if (args === null || args === undefined || i >= args.length) throw new SysException('IndexOutOfRangeException', 'printf: too few arguments');
	return args[i];
}

/** An integer argument as glibc reads it from the va_list: size bits (8, 16, 32 or 64) of the value, signed or
 *  unsigned. The value is the C# value the engine passes (an int, a long or ulong as a number or bigint, a bool, a
 *  char code); a double is truncated toward zero as x86 converts it. A number when the result is a safe integer,
 *  otherwise a bigint. (The C# runtime prints the whole C# value, which differs only where the C++ would print a
 *  value truncated to its length modifier's size; glibc is followed.) */
function intArg(a: any, size: number, signed: boolean): L {
	let v: L;
	if (typeof a === 'number') v = Number.isSafeInteger(a) ? a + 0 : d2l(a);
	else if (typeof a === 'bigint') v = a;
	else if (typeof a === 'boolean') v = a ? 1 : 0;
	else if (a === null || a === undefined) v = 0;
	else throw new SysException('InvalidCastException', 'printf: integer argument ' + a);
	if (typeof v === 'number') {
		switch (size) {
			case 64: return signed || v >= 0 ? v : BigInt(v) + 18446744073709551616n;
			case 32: return signed ? v | 0 : v >>> 0;
			case 16: return signed ? (v << 16) >> 16 : v & 0xffff;
			default: return signed ? (v << 24) >> 24 : v & 0xff;
		}
	}
	switch (size) {
		case 64: return signed ? BigInt.asIntN(64, v) : BigInt.asUintN(64, v);
		case 32: return Number(signed ? BigInt.asIntN(32, v) : BigInt.asUintN(32, v));
		case 16: return Number(signed ? BigInt.asIntN(16, v) : BigInt.asUintN(16, v));
		default: return Number(signed ? BigInt.asIntN(8, v) : BigInt.asUintN(8, v));
	}
}
function f64Arg(a: any): number {
	if (typeof a === 'number') return a;
	if (typeof a === 'bigint') return Number(a);
	if (typeof a === 'boolean') return a ? 1 : 0;
	if (a === null || a === undefined) return 0;
	throw new SysException('InvalidCastException', 'printf: floating argument ' + a);
}

// %s argument: [bytes, start, length], or null for a null pointer
let sB: ByteArr = null, sI = 0;
/** Sets sB / sI for a %s argument: a C string, a std::string (part A's Str), a char array pointer, a JavaScript
 *  string; sB = null for a null pointer. */
function strArg(a: any): void {
	if (a === null || a === undefined) { sB = null; return; }
	if (a instanceof cpp.CPtr) { sB = a.B as any; sI = a.O; return; }
	if (typeof a === 'string') { sB = R.Lit(a).B as any; sI = 0; return; }
	if (a instanceof cpp.Str) { const p = a.c_str(); sB = p.B as any; sI = p.O; return; }
	if (a instanceof cpp.Ptr) { const p: any = a; sB = p.a; sI = Number(p.o); return; }
	throw new SysException('InvalidCastException', 'printf: string argument ' + a);
}

function signBit(x: number): boolean { F64[0] = x; return (W32[1] >>> 31) === 1; }

/** The bytes printf writes for fmt and args into OB[0..ON): glibc's formatting, with the flags - + space # 0, width
 *  and precision (* too), the length modifiers hh h l ll L q j z t, and the conversions d i u o x X c s f F e E g G
 *  a A %. Returns the length. */
function formatInto(fmt: CPtr, args: any[]): number {
	ON = 0;
	const f: ByteArr = fmt.B as any;
	let k = fmt.O, ai = 0;
	for (;;) {
		let c = f[k] & 255;
		if (c === 0) break;
		if (c !== 37) {
			let e = k + 1;
			while ((c = f[e] & 255) !== 0 && c !== 37) e++;
			outBytes(f, k, e - k);
			k = e;
			continue;
		}
		k++;
		if ((f[k] & 255) === 37) { need(1); OB[ON++] = 37; k++; continue; }
		let left = false, plus = false, space = false, alt = false, zero = false;
		for (;; k++) {
			c = f[k] & 255;
			if (c === 45) left = true;
			else if (c === 43) plus = true;
			else if (c === 32) space = true;
			else if (c === 35) alt = true;
			else if (c === 48) zero = true;
			else break;
		}
		let width = 0, prec = -1;
		if ((f[k] & 255) === 42) {
			width = intArg(argAt(args, ai++), 32, true) as number;
			if (width < 0) { left = true; width = -width; }
			k++;
		} else while (isDig(c = f[k] & 255)) { width = width * 10 + (c - 48); k++; }
		if ((f[k] & 255) === 46) {
			k++;
			prec = 0;
			if ((f[k] & 255) === 42) {
				prec = intArg(argAt(args, ai++), 32, true) as number;
				if (prec < 0) prec = -1;
				k++;
			} else while (isDig(c = f[k] & 255)) { prec = prec * 10 + (c - 48); k++; }
		}
		let size = 32;                    // the integer argument's width in bits, from the length modifier
		for (;; k++) {
			c = f[k] & 255;
			if (c === 104) size = size === 16 ? 8 : 16;
			else if (c === 108 || c === 76 || c === 113 || c === 106 || c === 122 || c === 116) size = 64;
			else break;
		}
		const conv = f[k] & 255;
		k++;
		let sign = '', prefix = '', body = '';
		let numeric = true;
		switch (conv) {
			case 100: case 105: {                                   // d i
				const v = intArg(argAt(args, ai++), size, true);
				if (v < 0) sign = '-'; else if (plus) sign = '+'; else if (space) sign = ' ';
				body = (v < 0 ? -(v as any) : v).toString();
				if (prec >= 0) {
					zero = false;
					if (prec === 0 && v == 0) body = '';
					if (body.length < prec) body = '0'.repeat(prec - body.length) + body;
				}
				break;
			}
			case 117: case 120: case 88: case 111: {                // u x X o
				const u = intArg(argAt(args, ai++), size, false);
				body = conv === 117 ? u.toString() : conv === 111 ? u.toString(8) : conv === 120 ? u.toString(16) : u.toString(16).toUpperCase();
				if (prec >= 0) {
					zero = false;
					if (prec === 0 && u == 0) body = '';
					if (body.length < prec) body = '0'.repeat(prec - body.length) + body;
				}
				if (alt) {
					if (conv === 111 && (body.length === 0 || body.charCodeAt(0) !== 48)) body = '0' + body;
					else if (conv === 120 && u != 0) prefix = '0x';
					else if (conv === 88 && u != 0) prefix = '0X';
				}
				break;
			}
			case 99: {                                              // c
				const v = intArg(argAt(args, ai++), 64, true);
				const ch = typeof v === 'number' ? v & 255 : Number(v & 255n);
				const pad = width - 1;
				if (pad > 0 && !left) outPad(32, pad);
				need(1); OB[ON++] = ch;
				if (pad > 0 && left) outPad(32, pad);
				continue;
			}
			case 115: {                                             // s
				strArg(argAt(args, ai++));
				let n: number;
				if (sB === null) {
					const t = prec < 0 || prec >= 6 ? '(null)' : '';
					n = t.length;
					if (n < width && !left) outPad(32, width - n);
					outStr(t);
					if (n < width && left) outPad(32, width - n);
					continue;
				}
				const B = sB, i0 = sI;
				n = 0;                                              // with a precision, at most that many bytes are read
				if (prec < 0) n = strlenAt(B, i0);
				else while (n < prec && (B[i0 + n] & 255) !== 0) n++;
				if (n < width && !left) outPad(32, width - n);
				outBytes(B, i0, n);
				if (n < width && left) outPad(32, width - n);
				continue;
			}
			case 102: case 70: case 101: case 69: case 103: case 71: case 97: case 65: {
				const v = f64Arg(argAt(args, ai++));
				if (signBit(v)) sign = '-'; else if (plus) sign = '+'; else if (space) sign = ' ';
				const upper = conv === 70 || conv === 69 || conv === 71 || conv === 65;
				if (v !== v || v === Infinity || v === -Infinity) {
					body = v !== v ? (upper ? 'NAN' : 'nan') : (upper ? 'INF' : 'inf');
					zero = false;
				} else if (conv === 97 || conv === 65) {
					body = hexFloat(Math.abs(v), prec, alt);
					prefix = '0x';
					if (upper) { body = body.toUpperCase(); prefix = '0X'; }
				} else {
					if (prec < 0) prec = 6;
					body = R.FormatFloat(Math.abs(v), conv, prec, alt);
				}
				break;
			}
			default:
				throw new SysException('NotSupportedException', 'printf %' + String.fromCharCode(conv));
		}
		const n = sign.length + prefix.length + body.length;
		if (n >= width) { outStr(sign); outStr(prefix); outStr(body); }
		else if (left) { outStr(sign); outStr(prefix); outStr(body); outPad(32, width - n); }
		else if (zero && numeric) { outStr(sign); outStr(prefix); outPad(48, width - n); outStr(body); }
		else { outPad(32, width - n); outStr(sign); outStr(prefix); outStr(body); }
	}
	return ON;
}

// ---- exact decimal formatting

const P5: number[] = [];
for (let j = 0, p = 1; j <= 22; j++, p *= 5) P5[j] = p;
const P10: number[] = [];
for (let j = 0, p = 1; j <= 22; j++, p *= 10) P10[j] = p;

/** Whether a * 10^k (a > 0 finite, k an integer) is exactly halfway between two integers. */
function tieAt(a: number, k: number): boolean {
	F64[0] = a;
	const hi = W32[1], lo = W32[0];
	const ex = (hi >>> 20) & 0x7ff;
	let mhi = hi & 0xfffff, e: number;
	if (ex === 0) e = -1074; else { mhi |= 0x100000; e = ex - 1075; }
	let tz: number;
	if (lo !== 0) tz = 31 - Math.clz32(lo & -lo);
	else tz = 32 + 31 - Math.clz32(mhi & -mhi);
	e += tz;                                         // a = m * 2^e, m odd
	if (k >= 0) return e + k + 1 === 0;
	const j = -k;
	if (e + 1 - j !== 0 || j > 22) return false;
	const m = (mhi * 4294967296 + lo) / 2 ** tz;
	return m % P5[j] === 0;
}
/** The decimal string s (of a rounded-half-up result) rounded half to even instead, when the exact value was a tie:
 *  its last digit, odd after rounding up, is one too high. */
function evenLast(s: string): string {
	const last = s.charCodeAt(s.length - 1);
	return (last & 1) ? s.slice(0, -1) + String.fromCharCode(last - 1) : s;
}

/** round_half_even(a * 10^p) for p possibly negative (exact; a >= 0 finite). */
function scaledRound(a: number, p: number): bigint {
	if (a === 0) return 0n;
	const [m, e] = decompose(a);
	let num = m, den = 1n;
	if (e >= 0) num <<= BigInt(e); else den <<= BigInt(-e);
	if (p >= 0) num *= pow10n(p); else den *= pow10n(-p);
	let q = num / den;
	const r = num - q * den;
	const twice = r * 2n;
	if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
	return q;
}

/** %f of a >= 0 finite: prec fraction digits, rounded half to even on the exact value. toFixed is exact but rounds
 *  ties up; a tie is fixed afterwards. */
function fixedDigits(a: number, prec: number, alt: boolean): string {
	let s: string;
	if (prec <= 100 && a < 1e21) {
		s = a.toFixed(prec);
		if (a !== 0 && tieAt(a, prec)) s = evenLast(s);
	} else {
		const d = scaledRound(a, prec).toString();
		if (prec === 0) s = d;
		else {
			const dd = d.length <= prec ? '0'.repeat(prec - d.length + 1) + d : d;
			s = dd.slice(0, dd.length - prec) + '.' + dd.slice(dd.length - prec);
		}
	}
	if (prec === 0 && alt) s += '.';
	return s;
}
let expX = 0;
/** The prec + 1 significant digits of a > 0 finite, rounded half to even, and (in expX) the decimal exponent. */
function expRaw(a: number, prec: number): string {
	if (prec <= 100) {
		const s = a.toExponential(prec);
		const ei = s.indexOf('e');
		const X = parseInt(s.slice(ei + 1), 10);
		let d = prec > 0 ? s.charAt(0) + s.slice(2, ei) : s.slice(0, ei);
		if (tieAt(a, prec - X)) d = evenLast(d);
		expX = X;
		return d;
	}
	let E = Math.floor(Math.log10(a));
	for (let iter = 0; iter < 8; iter++) {
		const d = scaledRound(a, prec - E).toString();
		if (d.length === prec + 1) { expX = E; return d; }
		if (d.length > prec + 1) E++; else E--;
	}
	expX = E;
	return scaledRound(a, prec - E).toString();
}
function expDigits(a: number, prec: number, alt: boolean, upper: boolean): string {
	let d: string;
	if (a === 0) { d = '0'.repeat(prec + 1); expX = 0; }
	else d = expRaw(a, prec);
	const X = expX;
	const mant = d.charAt(0) + (prec > 0 ? '.' + d.slice(1) : (alt ? '.' : ''));
	const ax = X < 0 ? -X : X;
	return mant + (upper ? 'E' : 'e') + (X < 0 ? '-' : '+') + (ax < 10 ? '0' + ax : String(ax));
}
/** a < 10^P exactly (a > 0 finite). */
function ltPow10(a: number, P: number): boolean {
	if (P <= 22) return a < P10[P];
	expRaw(a, 20);                     // 21 digits cannot round up to the next power of ten: a double has at most 17 nines
	return expX < P;
}

/** glibc's %a of a non-negative finite double without the 0x prefix: h.hhhp+e with trailing zero digits dropped
 *  (0p+0 for zero, 0.hhhp-1022 for a subnormal); with a precision, rounded to that many digits, the leading digit and
 *  the fraction together (half to even, as glibc does in the default rounding mode). The C# runtime rounds the
 *  fraction alone; glibc is followed. */
function hexFloat(a: number, prec: number, alt: boolean): string {
	F64[0] = a;
	const hi = W32[1], lo = W32[0];
	const ex = (hi >>> 20) & 0x7ff;
	const man = (hi & 0xfffff) * 4294967296 + lo;   // 52 bits, exact
	let lead = 1, e: number;
	if (ex === 0) { lead = 0; e = man !== 0 ? -1022 : 0; } else e = ex - 1023;
	let digits: string;
	if (prec < 0) digits = man.toString(16).padStart(13, '0').replace(/0+$/, '');
	else if (prec < 13) {
		const drop = (13 - prec) * 4;
		const full = lead * 4503599627370496 + man;   // < 2^53
		const unit = 2 ** drop;
		let keep = Math.floor(full / unit);
		const rem = full - keep * unit, half = unit / 2;
		if (rem > half || (rem === half && keep % 2 === 1)) keep++;
		const fu = 2 ** (prec * 4);
		lead = Math.floor(keep / fu);
		digits = prec > 0 ? (keep - lead * fu).toString(16).padStart(prec, '0') : '';
	} else digits = man.toString(16).padStart(13, '0') + '0'.repeat(prec - 13);
	let s = String(lead);
	if (digits.length > 0 || alt) s += '.' + digits;
	return s + (e >= 0 ? 'p+' + e : 'p-' + (-e));
}

// ---- literals

const litCache = new Map<string, Uint8Array>();

// ---- strtok's state
let tokNext: CPtr = null;
function isIn(c: number, set: CPtr): boolean {
	const B: ByteArr = set.B as any;
	for (let j = set.O; ; j++) {
		const x = B[j] & 255;
		if (x === 0) return false;
		if (x === c) return true;
	}
}

// ---- fread / fwrite of typed values (little-endian, as x86); a short read returns 0 and leaves the value unchanged
const IO = new Uint8Array(8);
const IOV = new DataView(IO.buffer);
function readExact(f: CFile, n: number): boolean {
	let got = 0;
	while (got < n) {
		const r = f.S.Read(IO, got, n - got);
		if (r <= 0) { f.ReadFailed(); return false; }
		got += r;
	}
	return true;
}
function putL(v: L): void {
	if (typeof v === 'number') {
		const hi = Math.floor(v / 4294967296);
		IOV.setUint32(0, v - hi * 4294967296, true);
		IOV.setInt32(4, hi, true);
	} else IOV.setBigInt64(0, BigInt.asIntN(64, v), true);
}
function getL(): L {
	const hi = IOV.getInt32(4, true), lo = IOV.getUint32(0, true);
	if ((hi > -2097152 && hi < 2097152) || (hi === -2097152 && lo !== 0)) return hi * 4294967296 + lo;
	return IOV.getBigInt64(0, true);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function two(n: number): string { return n < 10 ? '0' + n : String(n); }

let tmpCounter = 0;

// ------------------------------------------------------------------------------------------------ class R

/** C# Cpp.R: the C library functions of the engine (static members). */
export class R {
	static DummyDouble = 0;
	static DummyInt = 0;

	// -------------------------------------------------------------------------------------------- conversions
	/** x86-64 cvttsd2si: NaN and out-of-range values give the "integer indefinite" value. */
	static D2I(x: number): number {
		if (x !== x || x >= 2147483648.0 || x <= -2147483649.0) return -2147483648;
		return Math.trunc(x) | 0;
	}
	static D2L(x: number): L { return d2l(x); }
	static Discard(o: any): void { }
	static Comma<T>(a: any, b: T): T { return b; }

	// -------------------------------------------------------------------------------------------- helpers the translator emits
	/** System.IO.File.Exists (RFs has it exactly as .NET does it). */
	static File_Exists(path: string): boolean { return cpp.RFs.File_Exists(path); }
	/** double.IsInfinity. */
	static isInf(x: number): boolean { return x === Infinity || x === -Infinity; }
	/** double.IsNegative: the sign bit (true for -0 and negative NaNs). */
	static signbit(x: number): boolean { return signBit(x); }
	/** The double whose 64 bits are hi:lo (two uint32s). */
	static f64bits(hi: number, lo: number): number { W32[1] = hi >>> 0; W32[0] = lo >>> 0; return F64[0]; }
	/** The float whose 32 bits are bits, as a number. */
	static f32bits(bits: number): number { W32f[0] = bits >>> 0; return F32[0]; }
	/** A C# throw expression. */
	static thr(e: any): never { throw e; }
	/** Non-short-circuit & and | of two booleans (both already evaluated). */
	static bAnd(a: boolean, b: boolean): boolean { return a && b; }
	static bOr(a: boolean, b: boolean): boolean { return a || b; }
	/** System.Object.GetHashCode: the value's hash (.NET's for int, long, bool and double; a stable per-object
	 *  number for objects, the object's own GetHashCode when it has one). */
	static hashCode(o: any): number {
		if (o === null || o === undefined) return 0;
		switch (typeof o) {
			case 'number': {
				if (Number.isInteger(o) && o >= -2147483648 && o <= 2147483647) return o | 0;
				if (Number.isSafeInteger(o)) { const b = BigInt(o); return Number(BigInt.asIntN(32, b ^ (b >> 32n))); }
				const d = o === 0 ? 0 : o;                         // .NET: -0.0 and 0.0 hash alike
				F64[0] = d !== d ? POS_NAN : d;
				return (W32[0] ^ W32[1]) | 0;
			}
			case 'bigint': return Number(BigInt.asIntN(32, o ^ (o >> 32n)));
			case 'boolean': return o ? 1 : 0;
			case 'string': { let h = 0; for (let i = 0; i < o.length; i++) h = (Math.imul(h, 31) + o.charCodeAt(i)) | 0; return h; }
		}
		if (typeof o.GetHashCode === 'function') return o.GetHashCode() | 0;
		return objId(o);
	}
	/** System.Object.Equals(a, b): numbers by value (NaN equals NaN, as double.Equals), objects by their Equals or
	 *  identity. */
	static equals(a: any, b: any): boolean {
		if (a === b) return true;
		if (a === null || a === undefined || b === null || b === undefined) return false;
		if (typeof a === 'number' && typeof b === 'number') return a !== a && b !== b;
		if ((typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint')) return a == b;
		if (typeof a.Equals === 'function') return !!a.Equals(b);
		return false;
	}
	/** System.Object.ToString: .NET's text for numbers (the shortest round-trip digits, scientific notation for an
	 *  exponent of 15 or more or below -4, the invariant culture's NaN and Infinity) and bools, the object's own
	 *  toString otherwise. */
	static toStr(x: any): string {
		if (x === null || x === undefined) return '';
		if (typeof x === 'boolean') return x ? 'True' : 'False';
		if (typeof x === 'bigint') return x.toString();
		if (typeof x === 'number') {
			if (x !== x) return 'NaN';
			if (x === Infinity) return 'Infinity';
			if (x === -Infinity) return '-Infinity';
			if (x === 0) return signBit(x) ? '-0' : '0';
			const s = x.toExponential();
			const ei = s.indexOf('e');
			const X = parseInt(s.slice(ei + 1), 10);
			if (X >= 15 || X < -4) {
				const ax = X < 0 ? -X : X;
				return s.slice(0, ei) + 'E' + (X < 0 ? '-' : '+') + (ax < 10 ? '0' + ax : String(ax));
			}
			return String(x);
		}
		return x.toString();
	}

	// -------------------------------------------------------------------------------------------- memory
	/** A string literal as a fresh NUL-terminated byte array (each char's low byte). */
	static Lit(s: string): CPtr {
		let t = litCache.get(s);
		if (t === undefined) {
			const n = s.length;
			t = new Uint8Array(n + 1);
			for (let i = 0; i < n; i++) t[i] = s.charCodeAt(i);
			if (n <= 1024 && litCache.size < 50000) litCache.set(s, t);
			else return newCPtr(t, 0);
		}
		return newCPtr(t.slice(), 0);
	}
	/** char a[n] = "literal": n bytes (at least the literal and its NUL), the literal's first, the rest zero. */
	static LitN(s: string, n: number): CPtr {
		const b = new Uint8Array(Math.max(n, s.length + 1));
		for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
		return newCPtr(b, 0);
	}
	/** char a[n]: n zero bytes (at least one). */
	static Buf_i(n: number): CPtr { return newCPtr(new Uint8Array(Math.max(n, 1)), 0); }
	static Buf_l(n: L): CPtr { return R.Buf_i(toI32(n)); }
	static Buf_ul(n: L): CPtr { return R.Buf_i(toI32(n)); }
	/** char a[n] initialised from a literal (at most n bytes of it). */
	static BufFrom(lit: CPtr, n: number): CPtr {
		const p = R.Buf_i(n);
		const B: ByteArr = lit.B as any, b: any = p.B;
		for (let i = 0; i < n; i++) {
			const c = B[lit.O + i] & 255;
			if (c === 0) break;
			b[i] = c;
		}
		return p;
	}
	/** The copy of a char array member: the whole buffer, the same offset. */
	static CopyBuf(p: CPtr): CPtr {
		if (p.B == null) return p;
		const B: any = p.B;
		return newCPtr(B.slice(), p.O);
	}
	static NewBufs(n: number, m: number): CPtr[] { return R.Bufs(n, m); }
	/** new T[n] of new T() each (the maker makes one). */
	static NewArray_i<T>(n: number, mk: () => T): T[] {
		if (n < 0) n = 0;
		const a = new Array<T>(n);
		for (let i = 0; i < n; i++) a[i] = mk();
		return a;
	}
	static NewArray_l<T>(n: L, mk: () => T): T[] { return R.NewArray_i(toI32(n), mk); }
	/** T[n][m] of default values. TypeScript cannot know default(T): the rows hold 0 (the engine does not call this). */
	static Jagged<T>(n: number, m: number): T[][] {
		const a: T[][] = new Array(n);
		for (let i = 0; i < n; i++) a[i] = new Array(m).fill(0);
		return a;
	}
	/** An array of the elements' Clone()s (null stays null). */
	static CloneArray<T>(a: T[]): T[] {
		if (a === null || a === undefined) return null;
		return a.map((x: any) => (x === null || x === undefined ? null : x.Clone()));
	}
	static CloneJagged<T>(a: T[][]): T[][] { return a.map((r) => r.slice()); }
	/** realloc of an array: the old elements, then the maker's (C# makes new T() for a class with a parameterless
	 *  constructor and leaves default(T) otherwise, which is what the maker returns). */
	static Realloc<T>(a: T[], n: number, mk: () => T): T[] {
		const c = new Array<T>(n);
		const m = a === null || a === undefined ? 0 : Math.min(a.length, n);
		for (let i = 0; i < m; i++) c[i] = a[i];
		for (let i = m; i < n; i++) c[i] = mk ? mk() : null;
		return c;
	}
	static free(o: any): void { }
	/** memset of a double array (the C# runtime zeroes n / 8 elements, whatever the byte). */
	static memset_dA_i_ul(a: number[], v: number, n: L): void {
		const cnt = Number(BigInt.asUintN(64, BigInt(n)) / 8n);
		for (let i = 0; i < cnt && i < a.length; i++) a[i] = 0;
	}
	static memset_dA_i_l(a: number[], v: number, n: L): void { R.memset_dA_i_ul(a, v, n); }
	static memset_dA_i_i(a: number[], v: number, n: number): void { R.memset_dA_i_ul(a, v, n); }

	// -------------------------------------------------------------------------------------------- strings
	/** The JavaScript string of a C string (each byte one char, Latin-1). */
	static Str(p: CPtr): string { const B: ByteArr = p.B as any; return latin1(B, p.O, strlenAt(B, p.O)); }
	/** A copy of a C string's bytes, without the terminator. */
	static Bytes(p: CPtr): Uint8Array {
		const B: ByteArr = p.B as any;
		const n = strlenAt(B, p.O);
		if (B instanceof Uint8Array) return B.slice(p.O, p.O + n);
		const r = new Uint8Array(n);
		for (let i = 0; i < n; i++) r[i] = B[p.O + i] & 255;
		return r;
	}
	static strlen(p: CPtr): number { return strlenAt(p.B as any, p.O); }
	static strcpy(d: CPtr, s: CPtr): CPtr {
		const n = strlenAt(s.B as any, s.O);
		setBytes(d, d.O, s.B as any, s.O, n + 1);          // through a copy when the arrays are the same (memmove)
		return d;
	}
	static strcat(d: CPtr, s: CPtr): CPtr {
		R.strcpy(newCPtr(d.B as any, d.O + strlenAt(d.B as any, d.O)), s);
		return d;
	}
	/** strcmp: the difference of the first unsigned bytes that differ. */
	static strcmp(a: CPtr, b: CPtr): number {
		const x: ByteArr = a.B as any, y: ByteArr = b.B as any;
		for (let i = a.O, j = b.O; ; i++, j++) {
			const c = x[i] & 255, d = y[j] & 255;
			if (c !== d) return c - d;
			if (c === 0) return 0;
		}
	}
	static strchr(s: CPtr, c: number): CPtr {
		const ch = c & 255, B: ByteArr = s.B as any;
		for (let i = s.O; ; i++) {
			const x = B[i] & 255;
			if (x === ch) return newCPtr(B, i);
			if (x === 0) return nullCPtr();
		}
	}
	static strrchr(s: CPtr, c: number): CPtr {
		const ch = c & 255, B: ByteArr = s.B as any;
		let r = -1;
		for (let i = s.O; ; i++) {
			const x = B[i] & 255;
			if (x === ch) r = i;
			if (x === 0) return r < 0 ? nullCPtr() : newCPtr(B, r);
		}
	}
	static strstr(h: CPtr, n: CPtr): CPtr {
		const H: ByteArr = h.B as any, N: ByteArr = n.B as any;
		const nl = strlenAt(N, n.O);
		if (nl === 0) return h;
		for (let i = h.O; (H[i] & 255) !== 0; i++) {
			let j = 0;
			while (j < nl && (H[i + j] & 255) === (N[n.O + j] & 255)) j++;
			if (j === nl) return newCPtr(H, i);
		}
		return nullCPtr();
	}
	static strcspn(s: CPtr, reject: CPtr): number {
		const B: ByteArr = s.B as any;
		let i = 0;
		for (;;) {
			const c = B[s.O + i] & 255;
			if (c === 0 || isIn(c, reject)) return i;
			i++;
		}
	}
	static strtok(s: CPtr, delim: CPtr): CPtr {
		if (s.B != null) tokNext = s;
		if (tokNext === null || tokNext.B == null) return nullCPtr();
		const t = tokNext, B: ByteArr = t.B as any;
		let p = t.O;
		while ((B[p] & 255) !== 0 && isIn(B[p] & 255, delim)) p++;      // skip leading delimiters
		if ((B[p] & 255) === 0) { tokNext = null; return nullCPtr(); }
		const start = p;
		while ((B[p] & 255) !== 0 && !isIn(B[p] & 255, delim)) p++;
		if ((B[p] & 255) !== 0) { setByte(t, p, 0); tokNext = newCPtr(B, p + 1); }
		else tokNext = null;
		return newCPtr(B, start);
	}
	static toupper(c: number): number { return c >= 97 && c <= 122 ? c - 32 : c; }

	// -------------------------------------------------------------------------------------------- numbers from text
	/** Whether the last strtod, atof, ScanDouble or sscanf floating conversion would have set errno to ERANGE in
	 *  glibc (overflow, or an underflow: a nonzero number read as zero, or a tiny inexact result); libstdc++'s
	 *  std::stod throws out_of_range on it (Str.stod). C# Cpp.R.ERange. */
	static get ERange(): boolean { return scanRange; }
	static strtod_CPtr(s: CPtr): number { return R.strtod_CPtr_CPtrr(s, null); }
	/** strtod as glibc: the value, and in end where the number ended (s itself when there is none). */
	static strtod_CPtr_CPtrr(s: CPtr, end: cpp.Ref<CPtr>): number {
		const v = scanDouble(s.B as any, s.O, -1, true);
		if (end !== null && end !== undefined) end.set(scanEnd < 0 ? s : newCPtr(s.B as any, scanEnd));
		return scanEnd < 0 ? 0 : v;
	}
	static atof(s: CPtr): number { return R.strtod_CPtr_CPtrr(s, null); }
	/** C# R.ScanDouble: a C floating number at b[o..] using at most maxw characters (after leading space when
	 *  skipSpace); the characters consumed (0: none) and, in v, the value. */
	static ScanDouble(b: ByteArr, o: number, maxw: number, v: cpp.Ref<number>, skipSpace: boolean = true): number {
		const r = scanDouble(b, o, maxw === 2147483647 ? -1 : maxw, skipSpace);
		if (scanEnd < 0) { v.set(0); return 0; }
		v.set(r);
		return scanEnd - o;
	}
	/** The C# runtime's strtol: optional space and sign, decimal digits (the engine passes base 10), clamped to long. */
	static strtol(s: CPtr, end: cpp.Ref<CPtr>, base: number): L {
		const b: ByteArr = s.B as any;
		let i = s.O;
		while (isSpace(b[i] & 255)) i++;
		let neg = false;
		if ((b[i] & 255) === 43 || (b[i] & 255) === 45) { neg = (b[i] & 255) === 45; i++; }
		const st = i;
		let u = 0, ub = 0n, big = false;
		for (let c: number; isDig(c = b[i] & 255); i++) {
			if (!big) {
				if (u < 900719925474099) u = u * 10 + (c - 48);
				else { big = true; ub = BigInt(u) * 10n + BigInt(c - 48); }
			} else if (ub <= 9223372036854775808n) ub = ub * 10n + BigInt(c - 48);
		}
		if (i === st) { if (end) end.set(s); return 0; }
		if (end) end.set(newCPtr(b, i));
		if (!big) return neg ? (u === 0 ? 0 : -u) : u;
		if (neg) return ub > 9223372036854775808n ? -9223372036854775808n : canonL(-ub);
		return ub > 9223372036854775807n ? 9223372036854775807n : canonL(ub);
	}
	/** atoi: strtol's long, then (int): the low 32 bits. */
	static atoi(s: CPtr): number { return toI32(R.strtol(s, null, 10)); }

	// -------------------------------------------------------------------------------------------- sscanf
	static RefI(a: (v: number) => void): ScanSetI { return new ScanSetI(a); }
	static RefL(a: (v: L) => void): ScanSetL { return new ScanSetL(a); }
	static RefD(a: (v: number) => void): ScanSetD { return new ScanSetD(a); }
	static RefF(a: (v: number) => void): ScanSetF { return new ScanSetF(a); }

	/** glibc's sscanf for the directives the engine uses: %d %i %u (decimal), %f %e %g %a (and capitals), %s, %c,
	 *  %[...], %n and %%, with * and widths and the h/l/L/z/j/t/q modifiers. Targets: the R.RefI / RefL / RefD / RefF
	 *  setters, R.Slot (the value is stashed for R.Back), char buffers (CPtr, or a char array cpp.Ptr) and cpp.Ref
	 *  cells. It returns the number of assignments, or EOF (-1) when the input ends before the first assignment.
	 *  The C# runtime handles fewer directives (no %n, scan sets or %a) and differs from glibc on the EOF rule and on
	 *  %u of negative or huge numbers; glibc is followed (as the Go and Java ports do). */
	static sscanf(s: CPtr, fmt: CPtr, ...args: any[]): number {
		stashReset();
		const b: ByteArr = s.B as any;
		let i = s.O;
		const f: ByteArr = fmt.B as any;
		let k = fmt.O, ai = 0, count = 0;
		const at = (j: number): number => b[j] & 255;
		for (;;) {
			const fc = f[k] & 255;
			if (fc === 0) break;
			if (isSpace(fc)) {
				while (isSpace(f[k] & 255)) k++;
				while (isSpace(at(i))) i++;
				continue;
			}
			if (fc !== 37) {
				if (at(i) === 0) return count === 0 ? -1 : count;
				if (at(i) !== fc) return count;
				i++;
				k++;
				continue;
			}
			k++;
			let suppress = false;
			if ((f[k] & 255) === 42) { suppress = true; k++; }
			let width = 0;
			for (let c: number; isDig(c = f[k] & 255); k++) width = width * 10 + (c - 48);
			let lmod = 0;
			for (let c: number; (c = f[k] & 255) === 108 || c === 104 || c === 76 || c === 122 || c === 106 || c === 116 || c === 113; k++)
				if (c !== 104) lmod++;
			const conv = f[k] & 255;
			k++;
			let set: Uint8Array = null;
			if (conv === 91) {
				set = new Uint8Array(256);
				let neg = false;
				if ((f[k] & 255) === 94) { neg = true; k++; }
				let first = true;
				for (;;) {
					const c = f[k] & 255;
					if (c === 0 || (!first && c === 93)) break;
					const nx = f[k + 1] & 255;
					if (c === 45 && !first && nx !== 93 && nx !== 0 && (f[k - 1] & 255) <= nx) {
						for (let x = f[k - 1] & 255; x <= nx; x++) set[x] = 1;
						k += 2;
						first = false;
						continue;
					}
					set[c] = 1;
					k++;
					first = false;
				}
				if ((f[k] & 255) === 93) k++;
				if (neg) { for (let x = 0; x < 256; x++) set[x] = set[x] ? 0 : 1; set[0] = 0; }
			}
			if (conv !== 99 && conv !== 91 && conv !== 110) while (isSpace(at(i))) i++;
			if (conv === 110) {
				if (!suppress) {
					if (ai >= args.length) throw tooFew();
					storeInt(args[ai++], i - s.O, lmod, false);
				}
				continue;
			}
			if (at(i) === 0) return count === 0 ? -1 : count;
			const w = width > 0 ? width : 1 << 30;
			switch (conv) {
				case 37:
					if (at(i) !== 37) return count;
					i++;
					break;
				case 100: case 105: case 117: {
					let j = i;
					const lim = i + w;
					let neg = false;
					if (j < lim && (at(j) === 43 || at(j) === 45)) { neg = at(j) === 45; j++; }
					const ds = j;
					let u = 0, ub = 0n, big = false, over = false;
					for (let c: number; j < lim && isDig(c = at(j)); j++) {
						if (!big) {
							if (u < 900719925474099) u = u * 10 + (c - 48);
							else { big = true; ub = BigInt(u) * 10n + BigInt(c - 48); }
						} else if (!over) {
							ub = ub * 10n + BigInt(c - 48);
							if (ub > 18446744073709551615n) over = true;
						}
					}
					if (j === ds) return count;
					i = j;
					const mag = big ? ub : BigInt(u);
					let v: L;
					if (conv === 117) {                 // strtoul: the magnitude, negated as an unsigned number (ULONG_MAX on overflow)
						let U = over ? 18446744073709551615n : neg ? BigInt.asUintN(64, -mag) : mag;
						v = lmod === 0 ? Number(U & 0xffffffffn) : canonL(U);
					} else if (!big) v = neg ? (u === 0 ? 0 : -u) : u;
					else if (neg) v = over || mag > 9223372036854775808n ? -9223372036854775808n : canonL(-mag);
					else v = over || mag > 9223372036854775807n ? 9223372036854775807n : canonL(mag);
					if (!suppress) {
						if (ai >= args.length) throw tooFew();
						storeInt(args[ai++], v, lmod, conv === 117);
						count++;
					}
					break;
				}
				case 102: case 101: case 103: case 69: case 71: case 97: case 65: case 70: {
					const e = scanFloat(b, i, width);
					if (e < 0) return count;
					// the characters taken are converted as strtod (or strtof, for a float) converts them
					const v = scanDouble(b, i, e - i, false);
					i = e;
					if (scanEnd < 0) return count;
					if (!suppress) {
						if (ai >= args.length) throw tooFew();
						const a = args[ai++];
						let fv = 0;
						if (lmod === 0) {
							if (scanKind === 2) fv = parseHex(scanHex, true);
							else if (scanKind === 1) fv = parseDecF(v);
							else if (v !== v) fv = nanF(signBit(v), scanNanPayload < 0n ? 0n : scanNanPayload);
							else fv = v;
						}
						if (a instanceof ScanSetD) a.Set(v);
						else if (a instanceof ScanSetF) a.Set(fv);
						else if (a instanceof ScanSlot) { if (lmod > 0) stash('d', v); else stash('f', fv); }
						else if (a !== null && a !== undefined && typeof a.set === 'function') a.set(lmod > 0 ? v : fv);
						else throw new SysException('ArgumentException', 'sscanf %' + String.fromCharCode(conv) + ' target ' + a);
						count++;
					}
					break;
				}
				case 115: case 91: {
					let j = i, m = 0;
					while (at(j) !== 0 && m < w) {
						const c = at(j);
						if (conv === 115 ? isSpace(c) : !set[c]) break;
						j++;
						m++;
					}
					if (m === 0) return count;           // only %[ can match nothing: a matching failure
					if (!suppress) {
						if (ai >= args.length) throw tooFew();
						const d = bufTarget(args[ai++]);
						setBytes(d, d.O, b, i, m);
						setByte(d, d.O + m, 0);
						count++;
					}
					i = j;
					break;
				}
				case 99: {
					const n = width > 0 ? width : 1;
					let a: any = null;
					if (!suppress) { if (ai >= args.length) throw tooFew(); a = args[ai++]; }
					for (let t = 0; t < n && at(i) !== 0; t++) {
						if (!suppress) {
							const c = at(i), sc = (c << 24) >> 24;
							if (a instanceof cpp.CPtr) setByte(a, a.O + t, c);
							else if (a instanceof ScanSetI) a.Set(sc);
							else if (a instanceof ScanSlot) stash(t === 0 ? 'c' : 'i', sc);
							else if (a !== null && typeof a.set === 'function' && !(a instanceof cpp.Ptr)) a.set(sc);
							else { const d = bufTarget(a); setByte(d, d.O + t, c); }
						}
						i++;
					}
					if (!suppress) count++;
					break;
				}
				default:
					throw new SysException('NotSupportedException', 'sscanf %' + String.fromCharCode(conv));
			}
		}
		return count;
	}

	// -------------------------------------------------------------------------------------------- Stash.cs
	/** A sscanf target that is a C pointer parameter (ref in C#): the value is stashed, then R.Back copies it. */
	static Slot: ScanSlot = new ScanSlot();
	// R.Back<T1, ...>(n, ref a, ...): copy the stashed values into the references (Convert.ChangeType to each
	// reference's type, whose code is the suffix), return n
	static Back_i_T1r__i(n: number, a: cpp.Ref<number>): number { take(0, 'i', a); return n; }
	static Back_i_T1r__u(n: number, a: cpp.Ref<number>): number { take(0, 'u', a); return n; }
	static Back_i_T1r__l(n: number, a: cpp.Ref<L>): number { take(0, 'l', a); return n; }
	static Back_i_T1r__ul(n: number, a: cpp.Ref<L>): number { take(0, 'ul', a); return n; }
	static Back_i_T1r__s(n: number, a: cpp.Ref<number>): number { take(0, 's', a); return n; }
	static Back_i_T1r__us(n: number, a: cpp.Ref<number>): number { take(0, 'us', a); return n; }
	static Back_i_T1r__c(n: number, a: cpp.Ref<number>): number { take(0, 'c', a); return n; }
	static Back_i_T1r__uc(n: number, a: cpp.Ref<number>): number { take(0, 'uc', a); return n; }
	static Back_i_T1r__ch(n: number, a: cpp.Ref<number>): number { take(0, 'ch', a); return n; }
	static Back_i_T1r__b(n: number, a: cpp.Ref<boolean>): number { take(0, 'b', a); return n; }
	static Back_i_T1r__f(n: number, a: cpp.Ref<number>): number { take(0, 'f', a); return n; }
	static Back_i_T1r__d(n: number, a: cpp.Ref<number>): number { take(0, 'd', a); return n; }
	static Back_i_T1r_T2r__l_c(n: number, a: cpp.Ref<L>, b: cpp.Ref<number>): number { take(0, 'l', a); take(1, 'c', b); return n; }
	/** Any R.Back: the reference type codes in order (the suffix of the call), then the references. */
	static BackCodes(codes: string[], n: number, ...refs: cpp.Ref<any>[]): number {
		for (let i = 0; i < refs.length; i++) take(i, codes[i], refs[i]);
		return n;
	}

	// -------------------------------------------------------------------------------------------- printf family
	static fprintf(f: CFile, fmt: CPtr, ...args: any[]): number {
		const n = formatInto(fmt, args);
		if (f === null || f === undefined) return -1;
		f.S.Write(OB, 0, n);
		return n;
	}
	/** snprintf with an unsigned size n: at most n - 1 bytes and the terminator; the length of the whole output. */
	static snprintf_CPtr_ul_CPtr_oA(buf: CPtr, n: L, fmt: CPtr, ...args: any[]): number {
		const len = formatInto(fmt, args);
		if (n != 0) {
			const m = n > len ? len : Number(n) - 1;
			setBytes(buf, buf.O, OB, 0, m);
			setByte(buf, buf.O + m, 0);
		}
		return len;
	}
	static snprintf_CPtr_l_CPtr_oA(buf: CPtr, n: L, fmt: CPtr, ...args: any[]): number {
		return R.snprintf_CPtr_ul_CPtr_oA(buf, canonUL(BigInt(n)), fmt, ...args);
	}
	static snprintf_CPtr_i_CPtr_oA(buf: CPtr, n: number, fmt: CPtr, ...args: any[]): number {
		return R.snprintf_CPtr_ul_CPtr_oA(buf, canonUL(BigInt(n)), fmt, ...args);
	}
	/** The bytes printf writes for fmt and args (a fresh array; C#'s Format returns byte[]). */
	static Format(fmt: CPtr, args: any[]): Uint8Array { const n = formatInto(fmt, args); return OB.slice(0, n); }
	/** Exact decimal formatting of a finite non-negative double for %f %e %g (and capitals), glibc's rounding: half to
	 *  even on the exact binary value. */
	static FormatFloat(a: number, conv: number, prec: number, alt: boolean): string {
		const lc = conv | 0x20;
		if (lc === 102) return fixedDigits(a, prec, alt);
		if (lc === 101) return expDigits(a, prec, alt, conv === 69);
		const P = prec === 0 ? 1 : prec;                 // %g as C99 specifies it
		let X = 0, d = '';
		if (a !== 0) { d = expRaw(a, P - 1); X = expX; }
		// glibc's quirk with '#': when rounding to P digits carries the value up to 10^P from an exponent of P - 1, it
		// keeps the fixed form's count of fraction digits (none) in the exponential form: %#g of 999999.5 is
		// "1.e+06", not "1.00000e+06" (%#.3g of 999.5 is "1.e+03"); without '#' the zeros are stripped anyway
		if (alt && X === P && P > 1 && ltPow10(a, P)) return expDigits(a, 0, true, conv === 71);
		let s: string;
		if (P > X && X >= -4) s = fixedDigits(a, P - 1 - X, alt);
		else if (a === 0) s = expDigits(a, P - 1, alt, conv === 71);
		else {
			const ax = X < 0 ? -X : X;
			s = d.charAt(0) + (P > 1 ? '.' + d.slice(1) : (alt ? '.' : '')) + (conv === 71 ? 'E' : 'e') + (X < 0 ? '-' : '+') + (ax < 10 ? '0' + ax : String(ax));
		}
		if (!alt) {
			let ep = s.indexOf('e');
			if (ep < 0) ep = s.indexOf('E');
			let mant = ep >= 0 ? s.slice(0, ep) : s;
			const ex = ep >= 0 ? s.slice(ep) : '';
			if (mant.indexOf('.') >= 0) {
				let e = mant.length;
				while (e > 0 && mant.charCodeAt(e - 1) === 48) e--;
				if (e > 0 && mant.charCodeAt(e - 1) === 46) e--;
				mant = mant.slice(0, e);
			}
			s = mant + ex;
		}
		return s;
	}

	// -------------------------------------------------------------------------------------------- files
	/** C's stdout: written through to file descriptor 1 at once, as C#'s Console stream is. */
	static stdout_: CFile = new CFile(CFileStream.stdOut(1), true);

	/** fopen as the C# runtime does it: r (r+: read and write) an existing file, w (w+) a new or truncated file, a an
	 *  append-only file; b and t are ignored; null when the file cannot be opened. A directory opened with "r" opens,
	 *  as glibc opens it: a CFile over the null stream (C#'s Stream.Null) with Dir set, whose every read fails with
	 *  the error indicator set and end-of-file clear (ReadFailed, ferror); any other mode refuses a directory. */
	static fopen(name: CPtr, mode: CPtr): CFile {
		const fn = R.Str(name), m = R.Str(mode);
		let fd = -1;
		try {
			if (m.length === 0 || fn.length === 0) return null;
			const plus = m.indexOf('+') >= 0;
			if (m[0] === 'r' && !plus && cpp.FsNet.dirExists(fn)) {
				const d = new CFile(CFileStream.nul(), false);
				d.Dir = true;
				return d;
			}
			let append = false;
			switch (m[0]) {
				case 'r': fd = fs.openSync(fn, plus ? 'r+' : 'r'); break;
				case 'w': fd = fs.openSync(fn, plus ? 'w+' : 'w'); break;
				case 'a': fd = fs.openSync(fn, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o666); append = true; break;
				default: return null;
			}
			const st = fs.fstatSync(fd);
			if (st.isDirectory()) { fs.closeSync(fd); return null; }
			const s = CFileStream.file(fd);
			if (append) { s.pos = st.size; s.floor = st.size; }
			return new CFile(s, false);
		} catch (e) {
			return null;
		}
	}
	static fclose(f: CFile): number {
		if (f === null || f === undefined) return -1;
		if (!f.IsStd) {
			f.S.Dispose();
			CFile.Open.delete(f);
		} else f.S.Flush();
		return 0;
	}
	/** What C's exit() does to open streams: flush every one (stdout and stderr too). */
	static FlushAll(): void {
		for (const f of Array.from(CFile.Open)) { try { f.S.Flush(); } catch (e) { } }
		try { R.stdout_.S.Flush(); } catch (e) { }
		try { R.stderr_.S.Flush(); } catch (e) { }
	}
	/** fflush; fflush(NULL) flushes every stream, as glibc does (the C# runtime does nothing for null). */
	static fflush(f: CFile): number {
		if (f === null || f === undefined) R.FlushAll();
		else f.S.Flush();
		return 0;
	}
	static feof(f: CFile): number { return f.Eof ? 1 : 0; }
	static rewind(f: CFile): void { f.S.Seek(0, 0); f.Eof = false; }
	static fseek_CFile_l_i(f: CFile, off: L, whence: number): number {
		try {
			f.S.Seek(off, whence);
			f.Eof = false;
			return 0;
		} catch (e) {
			return -1;
		}
	}
	static fseek_CFile_i_i(f: CFile, off: number, whence: number): number { return R.fseek_CFile_l_i(f, off, whence); }
	static ftell(f: CFile): L { return f.S.Position; }
	static fgets(buf: CPtr, n: number, f: CFile): CPtr {
		let i = 0;
		while (i < n - 1) {
			const c = f.S.ReadByte();
			if (c < 0) { f.ReadFailed(); break; }
			setByte(buf, buf.O + i++, c);
			if (c === 10) break;
		}
		if (i === 0) return nullCPtr();
		setByte(buf, buf.O + i, 0);
		return buf;
	}
	/** remove: 0 when the file (or empty directory) was deleted, -1 when it could not be (glibc; .NET's File.Delete
	 *  also succeeds for a missing file). */
	static remove(name: CPtr): number {
		const fn = R.Str(name);
		try { fs.unlinkSync(fn); return 0; }
		catch (e) {
			if (e && (e.code === 'EISDIR' || e.code === 'EPERM')) { try { fs.rmdirSync(fn); return 0; } catch (e2) { } }
			return -1;
		}
	}
	/** mkstemp: replaces the template's last six characters and creates the file; a stand-in descriptor (3), as the
	 *  C# runtime returns. */
	static mkstemp(template: CPtr): number {
		const n = strlenAt(template.B as any, template.O);
		const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
		tmpCounter++;
		for (let attempt = 0; attempt < 1000; attempt++) {
			for (let i = n - 6; i < n; i++) setByte(template, template.O + i, chars.charCodeAt(Math.floor(Math.random() * chars.length)));
			try { fs.closeSync(fs.openSync(R.Str(template), 'wx')); return 3; }
			catch (e) { if (!(e && e.code === 'EEXIST')) return -1; }
		}
		return -1;
	}

	static fwriteF1(v: number, f: CFile): number { IOV.setFloat32(0, v, true); f.S.Write(IO, 0, 4); return 1; }
	static fwriteD1(v: number, f: CFile): number { IOV.setFloat64(0, v, true); f.S.Write(IO, 0, 8); return 1; }
	static fwriteI1(v: number, f: CFile): number { IOV.setInt32(0, v, true); f.S.Write(IO, 0, 4); return 1; }
	static fwriteL1(v: L, f: CFile): number { putL(v); f.S.Write(IO, 0, 8); return 1; }
	static fwriteF(a: number[], off: number, n: number, f: CFile): number { for (let i = 0; i < n; i++) R.fwriteF1(a[off + i], f); return n; }
	static fwriteD(a: number[], off: number, n: number, f: CFile): number { for (let i = 0; i < n; i++) R.fwriteD1(a[off + i], f); return n; }
	static fwriteI(a: number[], off: number, n: number, f: CFile): number { for (let i = 0; i < n; i++) R.fwriteI1(a[off + i], f); return n; }
	static fwriteC(p: CPtr, off: number, n: number, f: CFile): number { if (n !== 0) f.S.Write(p.B as any, p.O + off, n); return n; }
	static freadF1(v: cpp.Ref<number>, f: CFile): number { if (!readExact(f, 4)) return 0; v.set(IOV.getFloat32(0, true)); return 1; }
	static freadD1(v: cpp.Ref<number>, f: CFile): number { if (!readExact(f, 8)) return 0; v.set(IOV.getFloat64(0, true)); return 1; }
	static freadI1(v: cpp.Ref<number>, f: CFile): number { if (!readExact(f, 4)) return 0; v.set(IOV.getInt32(0, true)); return 1; }
	static freadL1(v: cpp.Ref<L>, f: CFile): number { if (!readExact(f, 8)) return 0; v.set(getL()); return 1; }
	static freadF(a: number[], off: number, n: number, f: CFile): number {
		for (let i = 0; i < n; i++) { if (!readExact(f, 4)) return i; a[off + i] = IOV.getFloat32(0, true); }
		return n;
	}
	static freadD(a: number[], off: number, n: number, f: CFile): number {
		for (let i = 0; i < n; i++) { if (!readExact(f, 8)) return i; a[off + i] = IOV.getFloat64(0, true); }
		return n;
	}
	static freadI(a: number[], off: number, n: number, f: CFile): number {
		for (let i = 0; i < n; i++) { if (!readExact(f, 4)) return i; a[off + i] = IOV.getInt32(0, true); }
		return n;
	}
	static freadC(p: CPtr, off: number, n: number, f: CFile): number {
		const t = new Uint8Array(n);
		let got = 0;
		while (got < n) { const r = f.S.Read(t, got, n - got); if (r <= 0) { f.ReadFailed(); break; } got += r; }
		setBytes(p, p.O + off, t, 0, got);
		return got;
	}

	// -------------------------------------------------------------------------------------------- time
	static time_(): L { return Math.floor(Date.now() / 1000); }
	static time_Ptrl(p: cpp.Ptr<L>): L {
		const t = R.time_();
		if (!p.get_IsNull()) p.ref_Item_i(0).set(t);
		return t;
	}
	static ctime_Ptrl(p: cpp.Ptr<L>): CPtr { return R.ctime_l(p.get_Item_i(0)); }
	static difftime(end: L, start: L): number { return Number(subL(end, start)); }
	/** char a[n][m]: n zeroed rows of m bytes. */
	static Bufs(n: number, m: number): CPtr[] {
		const r: CPtr[] = new Array(n);
		for (let i = 0; i < n; i++) r[i] = R.Buf_i(m);
		return r;
	}
	/** ctime: "Www Mmm dd hh:mm:ss yyyy\n" in the local time zone (asctime's format: the day padded to two places with
	 *  a space, the year as many digits as it has). */
	static ctime_l(t: L): CPtr {
		const d = new Date(Number(t) * 1000);
		const s = DAYS[d.getDay()] + ' ' + MONS[d.getMonth()] + ' ' + (d.getDate() < 10 ? ' ' : '') + d.getDate() + ' '
			+ two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + ' ' + d.getFullYear() + '\n';
		return R.Lit(s);
	}

	// -------------------------------------------------------------------------------------------- Fs.cs (part D's RFs)
	// The C# partial class R's members in cs/runtime/Fs.cs are part D's class cpp.RFs; these forward to them.
	static get errno_(): number { return cpp.RFs.errno_; }
	static set errno_(v: number) { cpp.RFs.errno_ = v; }
	static get stderr_(): CFile { return cpp.RFs.stderr_; }
	static set stderr_(v: CFile) { cpp.RFs.stderr_ = v; }
	static get stdin_(): CFile { return cpp.RFs.stdin_; }
	static set stdin_(v: CFile) { cpp.RFs.stdin_ = v; }
	static getenv(name: CPtr): CPtr { return cpp.RFs.getenv(name); }
	static isdigit(c: number): number { return cpp.RFs.isdigit(c); }
	static isalpha(c: number): number { return cpp.RFs.isalpha(c); }
	static isalnum(c: number): number { return cpp.RFs.isalnum(c); }
	static isspace(c: number): number { return cpp.RFs.isspace(c); }
	static isupper(c: number): number { return cpp.RFs.isupper(c); }
	static islower(c: number): number { return cpp.RFs.islower(c); }
	static ispunct(c: number): number { return cpp.RFs.ispunct(c); }
	static isprint(c: number): number { return cpp.RFs.isprint(c); }
	static isxdigit(c: number): number { return cpp.RFs.isxdigit(c); }
	static tolower(c: number): number { return cpp.RFs.tolower(c); }
	static atol(s: CPtr): L { return cpp.RFs.atol(s); }
	static strtol0(s: CPtr, b: number = 10): L { return cpp.RFs.strtol0(s, b); }
	static ferror(f: CFile): number { return cpp.RFs.ferror(f); }
	static fileno(f: CFile): number { return cpp.RFs.fileno(f); }
	static setvbuf(f: CFile, b: CPtr, mode: number, size: L): number { return cpp.RFs.setvbuf(f, b, mode, size); }
	static rename(a: CPtr, b: CPtr): number { return cpp.RFs.rename(a, b); }
	static fgetc(f: CFile): number { return cpp.RFs.fgetc(f); }
	static time_o(p: any): L { return cpp.RFs.time_o(p); }
	static strncpy(d: CPtr, s: CPtr, n: L): CPtr { return cpp.RFs.strncpy(d, s, n); }
	static strncmp(a: CPtr, b: CPtr, n: L): number { return cpp.RFs.strncmp(a, b, n); }
	static memcmp(a: CPtr, b: CPtr, n: L): number { return cpp.RFs.memcmp(a, b, n); }
	static BufOf(n: number, vals: number[]): CPtr { return cpp.RFs.BufOf(n, vals); }
	static memcpyBuf(d: CPtr, s: CPtr): void { cpp.RFs.memcpyBuf(d, s); }
	static sprintf(buf: CPtr, fmt: CPtr, ...args: any[]): number { return cpp.RFs.sprintf(buf, fmt, ...args); }
}

// a stable number per object for this run (R.hashCode of an object without its own GetHashCode)
const objIds = new WeakMap<object, number>();
let nextObjId = 0;
function objId(o: object): number {
	let v = objIds.get(o);
	if (v === undefined) { v = ++nextObjId; objIds.set(o, v); }
	return v;
}
