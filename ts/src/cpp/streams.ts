// streams.ts - the iostreams the engine uses (C# cs/runtime/Streams.cs), with libstdc++'s formatting: a double is
// written with the printf format libstdc++'s num_put builds from the stream flags (%.*g by default, %.*f for fixed,
// %.*e for scientific, %a for fixed|scientific, '#' for showpoint) through the glibc-exact formatter (R.Format);
// width and fill are applied afterwards and width resets. A double is read by libstdc++'s num_get rules (the
// characters a number can have, then strtod), an integer as a token through strtol. The C# streams write to .NET
// Streams: a FileStream (ofstream,
// fstream), a MemoryStream (ostringstream) or a console stream (cout, cerr); here those are FileOut, MemStream
// (fsnet.ts) and the C stdio files R.stdout_ / R.stderr_, each console write flushed, so stream and printf output
// keep their order as .NET's unbuffered console streams keep it. An ifstream reads its file in blocks of 64 KiB
// (the C# IStream's buffer); seekg(off, ios::cur) is relative to the logical read position (the fixed C# port).
// Overloaded C# methods carry the translator's parameter suffix (Put(double) is Put_d, Get(ref int) is Get_ir,
// get() is get_), type-dependent ones a type suffix too (read<double>(Ptr, long) is read_PtrT_l__d).
// Runtime part D (cs/runtime/Streams.cs).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

import * as cpp from './index.js';
import { FsNet, FileOut, MemStream, type ByteArr } from './fsnet.js';

const EMPTY = new Uint8Array(0);

/** The libstdc++ values of ios_base::openmode, seekdir, fmtflags and iostate (C# Cpp.Ios). */
export class Ios {
	static readonly in = 8;
	static readonly out = 16;
	static readonly binary = 4;
	static readonly app = 1;
	static readonly trunc = 32;
	static readonly ate = 2;
	static readonly beg = 0;
	static readonly cur = 1;
	static readonly end = 2;
	static readonly boolalpha = 1;
	static readonly dec = 2;
	static readonly fixed = 4;
	static readonly hex = 8;
	static readonly internal = 16;
	static readonly left = 32;
	static readonly oct = 64;
	static readonly right = 128;
	static readonly scientific = 256;
	static readonly showbase = 512;
	static readonly showpoint = 1024;
	static readonly showpos = 2048;
	static readonly skipws = 4096;
	static readonly unitbuf = 8192;
	static readonly uppercase = 16384;
	static readonly adjustfield = 176;
	static readonly basefield = 74;
	static readonly floatfield = 260;
	static readonly goodbit = 0;
	static readonly badbit = 1;
	static readonly eofbit = 2;
	static readonly failbit = 4;
}

/** The values std::setprecision, std::setw and std::setfill return. */
export class SetPrec { readonly n: number; constructor(n: number) { this.n = n; } }
export class SetW { readonly n: number; constructor(n: number) { this.n = n; } }
export class SetFill { readonly c: number; constructor(c: number) { this.c = c; } }

function i32(x: cpp.L): number { return typeof x === 'bigint' ? Number(BigInt.asIntN(32, x)) : x | 0; }
function num(x: cpp.L): number { return typeof x === 'bigint' ? Number(x) : x; }

/** The state and format part of std::ios_base (C# Cpp.IosBase). */
export class IosBase {
	failbit = false;
	eofbit = false;
	badbit = false;
	prec: cpp.L = 6;
	flagsv = 0;
	widthv: cpp.L = 0;
	fillc = 32;

	good(): boolean { return !this.failbit && !this.eofbit && !this.badbit; }
	fail(): boolean { return this.failbit || this.badbit; }
	bad(): boolean { return this.badbit; }
	eof(): boolean { return this.eofbit; }
	ok(): boolean { return !this.fail(); }
	notok(): boolean { return this.fail(); }
	/** clear(state): as in the C# port, every flag is reset whatever the argument. */
	clear(s: number = 0): void { this.failbit = this.eofbit = this.badbit = false; }
	precision_(): cpp.L { return this.prec; }
	precision_l(p: cpp.L): cpp.L { const o = this.prec; this.prec = p; return o; }
	width_(): cpp.L { return this.widthv; }
	width_l(w: cpp.L): cpp.L { const o = this.widthv; this.widthv = w; return o; }
	fill_(): number { return this.fillc; }
	fill_i(c: number): number { const o = this.fillc; this.fillc = c; return o; }
	setf_i(f: number): number { const o = this.flagsv; this.flagsv |= f; return o; }
	setf_i_i(f: number, mask: number): number { const o = this.flagsv; this.flagsv = (this.flagsv & ~mask) | (f & mask); return o; }
	unsetf(f: number): void { this.flagsv &= ~f; }
	rdbuf(): any { return null; }
	imbue(l: any): void { }
	exceptions(m: number): void { }
}

// the printf formats of libstdc++'s __num_base::_S_format_float: [showpoint][g, f, e, a], made on first use
let floatFmts: cpp.CPtr[][] | null = null;
function floatFmt(showpoint: boolean, k: number): cpp.CPtr {
	if (floatFmts == null) {
		const R = cpp.R;
		floatFmts = [
			[R.Lit('%.*g'), R.Lit('%.*f'), R.Lit('%.*e'), R.Lit('%a')],
			[R.Lit('%#.*g'), R.Lit('%#.*f'), R.Lit('%#.*e'), R.Lit('%#a')],
		];
	}
	return floatFmts[showpoint ? 1 : 0][k];
}

/** std::ostream (C# Cpp.OStream). */
export class OStream extends IosBase {
	/** The file this stream writes (the C# s, when it is a FileStream). */
	s: FileOut | null = null;
	/** The in-memory bytes (the C# mem). */
	mem: MemStream | null = null;
	/** 1 = standard output, 2 = standard error (the C# s, when it is a console stream). */
	std = 0;

	/** cout (1) and cerr (2). */
	static Std(fd: number): OStream { const o = new OStream(); o.std = fd; return o; }

	stdFile(): any { return this.std === 1 ? cpp.R.stdout_ : cpp.R.stderr_; }

	/** (s ?? mem)?.Write(b, off, n). */
	Raw(b: ArrayLike<number>, off: number, n: number): void {
		if (this.s != null) this.s.write(b, off, n);
		else if (this.std !== 0) {
			if (n <= 0) return;
			const f = this.stdFile();
			f.S.Write(FsNet.u8(b, off, n), 0, n);
			f.S.Flush();
		}
		else if (this.mem != null) this.mem.write(b, off, n);
	}

	/** A formatted field: the fill before it (after it when left-adjusted) up to the width, which resets. */
	Pad(body: ArrayLike<number>, off: number, n: number): void {
		const w = num(this.widthv);
		this.widthv = 0;
		if (n >= w) { this.Raw(body, off, n); return; }
		const pad = new Uint8Array(w - n).fill(this.fillc & 0xFF);
		if ((this.flagsv & Ios.left) !== 0) { this.Raw(body, off, n); this.Raw(pad, 0, pad.length); }
		else { this.Raw(pad, 0, pad.length); this.Raw(body, off, n); }
	}
	PadAll(body: ArrayLike<number>): void { this.Pad(body, 0, body.length); }

	Put_Str(x: cpp.Str): OStream { this.Pad((x as any).b, 0, (x as any).n); return this; }
	Put_CPtr(x: cpp.CPtr): OStream { const p: any = x; this.Pad(p.B, p.O, FsNet.clen(p)); return this; }
	Put_c(c: number): OStream { this.PadAll([c & 0xFF]); return this; }
	Put_uc(c: number): OStream { this.PadAll([c & 0xFF]); return this; }
	Put_i(v: number): OStream { this.PadAll(FsNet.bytesOf(String(v))); return this; }
	Put_l(v: cpp.L): OStream { this.PadAll(FsNet.bytesOf(String(v))); return this; }
	Put_u(v: number): OStream { this.PadAll(FsNet.bytesOf(String(v))); return this; }
	Put_ul(v: cpp.L): OStream { this.PadAll(FsNet.bytesOf(String(v))); return this; }
	Put_s(v: number): OStream { return this.Put_i(v); }
	Put_b(v: boolean): OStream { this.PadAll(FsNet.bytesOf((this.flagsv & Ios.boolalpha) !== 0 ? (v ? 'true' : 'false') : (v ? '1' : '0'))); return this; }
	Put_f(v: number): OStream { return this.Put_d(v); }

	/** operator<<(double): the conversion letter from the floatfield, '#' for showpoint, the precision. */
	Put_d(v: number): OStream {
		const fx = (this.flagsv & Ios.fixed) !== 0, sci = (this.flagsv & Ios.scientific) !== 0;
		const sp = (this.flagsv & Ios.showpoint) !== 0;
		const body: ByteArr = fx && sci ? cpp.R.Format(floatFmt(sp, 3), [v])
			: cpp.R.Format(floatFmt(sp, fx ? 1 : sci ? 2 : 0), [i32(this.prec), v]);
		this.PadAll(body);
		return this;
	}

	Put_SetPrec(p: SetPrec): OStream { this.prec = p.n; return this; }
	Put_SetW(w: SetW): OStream { this.widthv = w.n; return this; }
	Put_SetFill(f: SetFill): OStream { this.fillc = f.c; return this; }
	Put_OStream(o: OStream): OStream { return this; }
	Manip_endl(): OStream { this.Raw([10], 0, 1); this.flush(); return this; }
	Manip_flush(): OStream { this.flush(); return this; }
	Manip_setprecision(n: cpp.L): OStream { this.prec = n; return this; }
	Manip_setw(n: cpp.L): OStream { this.widthv = n; return this; }
	Manip_setfill(c: number): OStream { this.fillc = c; return this; }

	/** std::quoted(s): s between double quotes, with every '"' and '\\' escaped by a backslash; the width applies
	 *  to the whole quoted string, as in libstdc++ (__ostream_insert of the built string). */
	Manip_quoted_Str(x: cpp.Str): OStream {
		const xb: ArrayLike<number> = (x as any).b, xn: number = (x as any).n;
		const b = new Uint8Array(2 * xn + 2);
		let k = 0;
		b[k++] = 34;
		for (let i = 0; i < xn; i++) {
			const c = xb[i] & 0xFF;
			if (c === 34 || c === 92) b[k++] = 92;
			b[k++] = c;
		}
		b[k++] = 34;
		this.Pad(b, 0, k);
		return this;
	}
	Manip_quoted_CPtr(x: cpp.CPtr): OStream { return this.Manip_quoted_Str(cpp.Str.new_CPtr(x)); }
	Manip_fixed(): OStream { this.flagsv = (this.flagsv & ~(Ios.fixed | Ios.scientific)) | Ios.fixed; return this; }
	Manip_scientific(): OStream { this.flagsv = (this.flagsv & ~(Ios.fixed | Ios.scientific)) | Ios.scientific; return this; }
	Manip_defaultfloat(): OStream { this.flagsv &= ~(Ios.fixed | Ios.scientific); return this; }
	Manip_left(): OStream { this.flagsv = (this.flagsv & ~(Ios.left | Ios.right)) | Ios.left; return this; }
	Manip_right(): OStream { this.flagsv = (this.flagsv & ~(Ios.left | Ios.right)) | Ios.right; return this; }
	Manip_boolalpha(): OStream { this.flagsv |= Ios.boolalpha; return this; }
	Manip_noboolalpha(): OStream { this.flagsv &= ~Ios.boolalpha; return this; }
	Manip_showpoint(): OStream { this.flagsv |= Ios.showpoint; return this; }
	Manip_noshowpoint(): OStream { this.flagsv &= ~Ios.showpoint; return this; }

	/** write(p, n): n raw bytes (none, even at a null pointer, for n = 0: os.write(v.data(), 0) of an empty vector). */
	write_CPtr_l(p: cpp.CPtr, n: cpp.L): OStream { const q: any = p; if (n != 0) this.Raw(q.B, q.O, i32(n)); return this; }

	// write((const char*)p, n) of an array of numbers: its first n bytes (Mem.BytesOf)
	writePod(p: any, n: cpp.L, t: string): OStream { const b = FsNet.podOf(p, i32(n), t); this.Raw(b, 0, b.length); return this; }
	write_PtrT_l__c(p: cpp.Ptr<number>, n: cpp.L): OStream { return this.writePod(p, n, 'c'); }
	write_PtrT_l__uc(p: cpp.Ptr<number>, n: cpp.L): OStream { return this.writePod(p, n, 'uc'); }
	write_PtrT_l__b(p: cpp.Ptr<boolean>, n: cpp.L): OStream { return this.writePod(p, n, 'b'); }
	write_PtrT_l__s(p: cpp.Ptr<number>, n: cpp.L): OStream { return this.writePod(p, n, 's'); }
	write_PtrT_l__us(p: cpp.Ptr<number>, n: cpp.L): OStream { return this.writePod(p, n, 'us'); }
	write_PtrT_l__i(p: cpp.Ptr<number>, n: cpp.L): OStream { return this.writePod(p, n, 'i'); }
	write_PtrT_l__u(p: cpp.Ptr<number>, n: cpp.L): OStream { return this.writePod(p, n, 'u'); }
	write_PtrT_l__l(p: cpp.Ptr<cpp.L>, n: cpp.L): OStream { return this.writePod(p, n, 'l'); }
	write_PtrT_l__ul(p: cpp.Ptr<cpp.L>, n: cpp.L): OStream { return this.writePod(p, n, 'ul'); }
	write_PtrT_l__f(p: cpp.Ptr<number>, n: cpp.L): OStream { return this.writePod(p, n, 'f'); }
	write_PtrT_l__d(p: cpp.Ptr<number>, n: cpp.L): OStream { return this.writePod(p, n, 'd'); }

	/** s?.Flush(): a file's buffer reaches the file; the console streams write through at once. */
	flush(): OStream {
		if (this.s != null) this.s.flush();
		else if (this.std !== 0) cpp.R.fflush(this.stdFile());
		return this;
	}

	/** The put position: the file's (with what is buffered), the MemoryStream's, 0 with neither. */
	tellp(): cpp.L {
		if (this.s != null) return this.s.position();
		if (this.std !== 0) throw new cpp.SysException('NotSupportedException', 'Stream does not support seeking.');
		return this.mem != null ? this.mem.pos : 0;
	}

	seekp(pos: cpp.L, dir: number = Ios.beg): OStream {
		if (this.s != null) this.s.seek(num(pos), dir);
		else if (this.std !== 0) throw new cpp.SysException('NotSupportedException', 'Stream does not support seeking.');
		else if (this.mem != null) this.mem.seek(num(pos), dir);
		return this;
	}
}

/** std::ostringstream over a MemoryStream (C# Cpp.OStringStream): str() is every byte written;
 *  ostringstream(init) starts with init's bytes and the put position at the start, so writes overwrite it. */
export class OStringStream extends OStream {
	constructor() { super(); this.mem = new MemStream(); }
	static new_Str(init: cpp.Str): OStringStream {
		const o = new OStringStream();
		o.mem.write((init as any).b, 0, (init as any).n);
		o.mem.pos = 0;
		return o;
	}
	static new_i(mode: number): OStringStream { return new OStringStream(); }

	/** str(): the whole MemoryStream. */
	str_(): cpp.Str { const b = this.mem.toArray(); return FsNet.strOf(b, 0, b.length); }

	/** str(x): the contents replaced by x, the put position at its end. */
	str_Str(x: cpp.Str): void { this.mem = new MemStream(); this.mem.write((x as any).b, 0, (x as any).n); }

	/** The move assignment: the bytes, the precision and the flags (the source is left empty). */
	MoveFrom(o: OStringStream): void { this.mem = o.mem; this.prec = o.prec; this.flagsv = o.flagsv; o.mem = new MemStream(); }
}

/** std::ofstream over a FileStream with a 64 KiB buffer (C# Cpp.OFStream): ios::app appends (FileMode.Append),
 *  any other mode creates or truncates (FileMode.Create); a file that cannot be opened leaves the stream closed with
 *  failbit set. Dispose is the destructor, which closes the file; a stream that is never closed keeps its buffered
 *  bytes, as the C# FileStream does at exit. */
export class OFStream extends OStream {
	static new_Str_i(path: cpp.Str, mode: number = Ios.out): OFStream { const f = new OFStream(); f.open_Str_i(path, mode); return f; }
	static new_CPtr_i(path: cpp.CPtr, mode: number = Ios.out): OFStream { const f = new OFStream(); f.open_Str_i(cpp.Str.new_CPtr(path), mode); return f; }
	static new_FsPath_i(path: any, mode: number = Ios.out): OFStream { const f = new OFStream(); f.open_Str_i(path.p, mode); return f; }

	open_Str_i(path: cpp.Str, mode: number = Ios.out): void {
		if (this.s != null) { const old = this.s; this.s = null; old.close(); }
		try {
			const app = (mode & Ios.app) !== 0;
			const fd = FsNet.open(FsNet.s(path), app ? FsNet.APPEND : FsNet.CREATE);
			try { this.s = new FileOut(fd, 1 << 16, app); }
			catch (e) { FsNet.closeFd(fd); throw e; }
			this.failbit = false;
		} catch (e) {
			this.s = null;
			this.failbit = true;
		}
	}
	open_FsPath_i(path: any, mode: number = Ios.out): void { this.open_Str_i(path.p, mode); }

	is_open(): boolean { return this.s != null; }
	close(): void { if (this.s != null) { const f = this.s; this.s = null; f.close(); } }
	/** ~basic_ofstream closes the file. */
	Dispose(): void { this.close(); }
	MoveFrom(o: OFStream): void { this.s = o.s; o.s = null; }
}

/** std::istream as the C# port has it (C# Cpp.IStream): a buffer of bytes (the whole string of an istringstream, or
 *  the last block of up to 64 KiB read from an ifstream's file) and the read position in it. A double is extracted
 *  by libstdc++'s num_get rules (Get_dr); the other formatted extractions read one whitespace-delimited token and
 *  convert it with strtol (a token that does not convert whole sets failbit and stores 0; an int out of range stores
 *  the nearest limit). getline consumes the delimiter; at the end of the input it sets eof, and fail too when
 *  nothing at all was read. An ifstream on a directory fails its first read with badbit and failbit, not eofbit
 *  (dir, AtEnd). seekg clears eof; on a file, ios::cur is relative to the logical read position. */
export class IStream extends IosBase {
	buf: Uint8Array = EMPTY;
	pos = 0;
	len = 0;
	/** The file descriptor an ifstream reads (the C# src), or -1. */
	src = -1;
	/** The file offset just past the bytes read from src (FileStream.Position). */
	srcPos = 0;
	gcountv: cpp.L = 0;
	/** An ifstream opened on a directory: libstdc++ opens it (open(2) of a directory for reading succeeds) and the
	 *  first read fails with EISDIR, which basic_filebuf::underflow throws as ios_base::failure and the extraction
	 *  catches: badbit and failbit, not eofbit (C# Cpp.IStream.dir). */
	dir = false;

	Fill(): boolean {
		if (this.pos < this.len) return true;
		if (this.dir) { this.badbit = true; this.failbit = true; return false; }
		if (this.src < 0) return false;
		if (this.buf.length === 0) this.buf = new Uint8Array(1 << 16);
		const k = FsNet.readAt(this.src, this.buf, 0, this.buf.length, this.srcPos);
		this.srcPos += k;
		this.len = k;
		this.pos = 0;
		return this.len > 0;
	}

	/** A read found no more input: the end of the input sets eofbit; a failed read (dir) set badbit instead. */
	AtEnd(): void { if (!this.dir) this.eofbit = true; }
	peek(): number { if (!this.Fill()) { this.AtEnd(); return -1; } return this.buf[this.pos]; }
	get_(): number { if (!this.Fill()) { this.AtEnd(); this.failbit = true; return -1; } this.gcountv = 1; return this.buf[this.pos++]; }
	get_cr(c: cpp.Ref<number>): IStream { const x = this.get_(); if (x >= 0) c.set((x << 24) >> 24); return this; }
	ignore(n: cpp.L = 1, delim: number = -1): IStream {
		const m = num(n);
		for (let i = 0; i < m; i++) { const c = this.get_(); if (c < 0 || c === delim) break; }
		this.failbit = this.failbit && !this.eofbit;
		return this;
	}
	gcount(): cpp.L { return this.gcountv; }

	/** read(p, n): up to n bytes; fewer set eof and fail. gcount is the number read. */
	read_CPtr_l(p: cpp.CPtr, n: cpp.L): IStream {
		const q: any = p;
		const want = num(n);
		let got = 0;
		while (got < want) {
			if (!this.Fill()) break;
			const k = Math.min(want - got, this.len - this.pos);
			FsNet.copy(this.buf, this.pos, q.B, q.O + got, k);
			this.pos += k;
			got += k;
		}
		this.gcountv = got;
		if (got < want) { this.AtEnd(); this.failbit = true; }
		return this;
	}

	// read((char*)p, n) into an array of numbers: its first gcount bytes are replaced (Mem.BytesInto)
	readPod(p: any, n: cpp.L, t: string): IStream {
		const tmp = new Uint8Array(num(n));
		this.read_CPtr_l(new cpp.CPtr(tmp as any, 0), n);
		FsNet.podInto(p, tmp, 0, num(this.gcountv), t);
		return this;
	}
	read_PtrT_l__c(p: cpp.Ptr<number>, n: cpp.L): IStream { return this.readPod(p, n, 'c'); }
	read_PtrT_l__uc(p: cpp.Ptr<number>, n: cpp.L): IStream { return this.readPod(p, n, 'uc'); }
	read_PtrT_l__b(p: cpp.Ptr<boolean>, n: cpp.L): IStream { return this.readPod(p, n, 'b'); }
	read_PtrT_l__s(p: cpp.Ptr<number>, n: cpp.L): IStream { return this.readPod(p, n, 's'); }
	read_PtrT_l__us(p: cpp.Ptr<number>, n: cpp.L): IStream { return this.readPod(p, n, 'us'); }
	read_PtrT_l__i(p: cpp.Ptr<number>, n: cpp.L): IStream { return this.readPod(p, n, 'i'); }
	read_PtrT_l__u(p: cpp.Ptr<number>, n: cpp.L): IStream { return this.readPod(p, n, 'u'); }
	read_PtrT_l__l(p: cpp.Ptr<cpp.L>, n: cpp.L): IStream { return this.readPod(p, n, 'l'); }
	read_PtrT_l__ul(p: cpp.Ptr<cpp.L>, n: cpp.L): IStream { return this.readPod(p, n, 'ul'); }
	read_PtrT_l__f(p: cpp.Ptr<number>, n: cpp.L): IStream { return this.readPod(p, n, 'f'); }
	read_PtrT_l__d(p: cpp.Ptr<number>, n: cpp.L): IStream { return this.readPod(p, n, 'd'); }

	/** getline(s, line, delim): the bytes up to the delimiter (consumed, not stored). */
	ReadLine(s: cpp.Str, delim: number): boolean {
		const str: any = s;
		str.clear();
		let any = false;
		for (;;) {
			if (!this.Fill()) { this.AtEnd(); if (!any) this.failbit = true; return any; }
			any = true;
			let k = this.pos;
			const b = this.buf, len = this.len;
			if (delim >= 0 && delim <= 255) { while (k < len && b[k] !== delim) k++; }
			else k = len;
			if (k > this.pos) str.append_CPtr_ul(new cpp.CPtr(b as any, this.pos), k - this.pos);
			if (k < len) { this.pos = k + 1; return true; }
			this.pos = len;
		}
	}

	static ws(c: number): boolean { return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12; }

	SkipWs(): void { while (this.Fill() && IStream.ws(this.buf[this.pos])) this.pos++; }

	Token(): any {
		this.SkipWs();
		const t: any = new cpp.Str();
		while (this.Fill() && !IStream.ws(this.buf[this.pos])) t.push_back(this.buf[this.pos++]);
		if (t.n === 0) { this.failbit = true; if (!this.Fill()) this.AtEnd(); }
		else if (!this.Fill()) this.AtEnd();
		return t;
	}

	Get_Str(s: cpp.Str): IStream { const t = this.Token(); if (t.n > 0) (s as any).Assign_Str(t); return this; }

	/** is >> std::ws: skip whitespace (eof is set if the input ends there, failbit is not). */
	Manip_ws(): IStream {
		for (;;) {
			if (!this.Fill()) { this.AtEnd(); break; }
			const c = this.buf[this.pos];
			if (c === 32 || (c >= 9 && c <= 13)) this.pos++; else break;
		}
		return this;
	}

	/** is >> v for a double, as libstdc++ does it (C# Cpp.IStream.Get(ref double), java/src/cpp/IStream.java Get_dr):
	 *  the sentry (a stream not good extracts nothing; white space skipped; at the end of the input eof and fail, v
	 *  unchanged); num_get's _M_extract_float takes the characters a C-locale number can have (a sign, one of any
	 *  leading zeros, digits, one '.', and an 'e' after a digit with its sign), stopping at the first other one,
	 *  which stays in the stream ("0x10" is read as 0, then x10 is left); the gnu __convert_to_v converts them with
	 *  strtod: not all of them converted (nothing, "1e", "inf") is failbit with v = 0, an overflow (+-inf) is
	 *  failbit with v = +-DBL_MAX, an underflow is no error. eofbit when the number ends the input. */
	Get_dr(v: cpp.Ref<number>): IStream {
		if (!this.good()) { this.failbit = true; return this; }     // the sentry: a stream not good extracts nothing
		this.SkipWs();
		if (!this.Fill()) { this.AtEnd(); this.failbit = true; return this; }
		const acc: number[] = [];
		let more = true;
		let c: number = this.buf[this.pos];
		// the next character (-1, and more false, at the end of the input)
		const next = (): number => { this.pos++; more = this.Fill(); return more ? this.buf[this.pos] : -1; };
		if (c === 43 || c === 45) { acc.push(c); c = next(); }                      // the sign
		let mantissa = false, dec = false, sci = false;
		while (more && c === 48) { if (!mantissa) { acc.push(48); mantissa = true; } c = next(); }   // leading zeros, one kept
		while (more) {
			if (c >= 48 && c <= 57) { acc.push(c); mantissa = true; }
			else if (c === 46 && !dec && !sci) { acc.push(46); dec = true; }
			else if ((c === 101 || c === 69) && !sci && mantissa) {
				acc.push(101); sci = true;
				c = next();
				if (!more) break;
				if (c === 43 || c === 45) acc.push(c);
				else continue;                                                      // look at this character again
			}
			else break;
			c = next();
		}
		if (!more) this.AtEnd();
		acc.push(0);
		const a = Uint8Array.from(acc);
		const r = new cpp.Cell<number>(0);
		const n = cpp.R.ScanDouble(a, 0, 2147483647, r, false);
		if (n === 0 || a[n] !== 0) { v.set(0); this.failbit = true; }
		else if (r.v === Infinity) { v.set(1.7976931348623157e308); this.failbit = true; }
		else if (r.v === -Infinity) { v.set(-1.7976931348623157e308); this.failbit = true; }
		else v.set(r.v);
		return this;
	}
	Get_fr(v: cpp.Ref<number>): IStream { const d = new cpp.Cell<number>(0); this.Get_dr(d); v.set(Math.fround(d.v)); return this; }
	Get_ir(v: cpp.Ref<number>): IStream {
		const t = this.Token();
		if (t.n === 0) { v.set(0); return this; }
		const p = t.c_str();
		const end = new cpp.Cell<cpp.CPtr>(p);
		const r: cpp.L = cpp.R.strtol(p, end, 10);
		if ((end.v as any).O !== t.n || r < -2147483648 || r > 2147483647) {
			this.failbit = true;
			v.set(r < -2147483648 ? -2147483648 : r > 2147483647 ? 2147483647 : 0);
			return this;
		}
		v.set(Number(r));
		return this;
	}
	Get_lr(v: cpp.Ref<cpp.L>): IStream {
		const t = this.Token();
		if (t.n === 0) { v.set(0); return this; }
		const p = t.c_str();
		const end = new cpp.Cell<cpp.CPtr>(p);
		const r: cpp.L = cpp.R.strtol(p, end, 10);
		if ((end.v as any).O !== t.n) { this.failbit = true; v.set(0); return this; }
		v.set(r);
		return this;
	}
	Get_ulr(v: cpp.Ref<cpp.L>): IStream { const x = new cpp.Cell<cpp.L>(0); this.Get_lr(x); v.set(cpp.L.toU64(x.v)); return this; }
	Get_ur(v: cpp.Ref<number>): IStream { const x = new cpp.Cell<cpp.L>(0); this.Get_lr(x); v.set(cpp.L.toU32(x.v)); return this; }
	Get_cr(c: cpp.Ref<number>): IStream { this.SkipWs(); const x = this.get_(); if (x >= 0) c.set((x << 24) >> 24); return this; }

	/** The read position: the file offset of the next byte, or the index in the string. */
	tellg(): cpp.L { return this.src >= 0 ? this.srcPos - (this.len - this.pos) : this.pos; }

	seekg(off: cpp.L, dir: number = Ios.beg): IStream {
		this.eofbit = false;
		const o = num(off);
		if (this.src >= 0) {
			// ios::cur is relative to the read position, not to the file's, which is past the buffered block
			const np = dir === Ios.beg ? o : dir === Ios.cur ? num(this.tellg()) + o : FsNet.fdSize(this.src) + o;
			if (np < 0) { this.failbit = true; return this; }
			this.srcPos = np;
			this.pos = this.len = 0;
		}
		else this.pos = i32(dir === Ios.beg ? o : dir === Ios.cur ? this.pos + o : this.len + o);
		return this;
	}
}

/** std::istringstream (C# Cpp.IStringStream): a copy of the string to read from. */
export class IStringStream extends IStream {
	static new_Str(s: cpp.Str): IStringStream { const r = new IStringStream(); r.str_Str(s); return r; }
	static new_Str_i(s: cpp.Str, mode: number): IStringStream { const r = new IStringStream(); r.str_Str(s); return r; }

	/** str(x): a copy of x to read from the start; fail and eof are cleared. */
	str_Str(s: cpp.Str): void {
		this.buf = FsNet.copyOf((s as any).b, 0, (s as any).n);
		this.pos = 0;
		this.len = this.buf.length;
		this.failbit = this.eofbit = false;
	}
	str_(): cpp.Str { return FsNet.strOf(this.buf, 0, this.len); }
	MoveFrom(o: IStringStream): void { this.buf = o.buf; this.pos = o.pos; this.len = o.len; }
}

/** std::ifstream over a FileStream (C# Cpp.IFStream): a missing file leaves the stream closed with failbit set; a
 *  directory opens, as libstdc++ opens it, and every read then fails (IStream.dir). Dispose is the destructor, which
 *  closes the file. */
export class IFStream extends IStream {
	static new_Str_i(path: cpp.Str, mode: number = Ios.in): IFStream { const f = new IFStream(); f.open_Str_i(path, mode); return f; }
	static new_CPtr_i(path: cpp.CPtr, mode: number = Ios.in): IFStream { const f = new IFStream(); f.open_Str_i(cpp.Str.new_CPtr(path), mode); return f; }
	static new_FsPath_i(path: any, mode: number = Ios.in): IFStream { const f = new IFStream(); f.open_Str_i(path.p, mode); return f; }

	open_Str_i(path: cpp.Str, mode: number = Ios.in): void {
		if (this.src >= 0) { FsNet.closeFd(this.src); this.src = -1; }
		this.dir = false;
		try {
			if (FsNet.dirExists(FsNet.s(path))) {
				// libstdc++ opens a directory for reading; every read then fails (see IStream.dir)
				this.dir = true;
				this.srcPos = 0;
				this.failbit = false;
				this.pos = this.len = 0;
				return;
			}
			this.src = FsNet.open(FsNet.s(path), FsNet.READ);
			this.srcPos = 0;
			this.failbit = false;
			this.pos = this.len = 0;
		} catch (e) {
			this.src = -1;
			this.failbit = true;
		}
	}
	open_FsPath_i(path: any, mode: number = Ios.in): void { this.open_Str_i(path.p, mode); }
	is_open(): boolean { return this.src >= 0 || this.dir; }
	close(): void { if (this.src >= 0) { FsNet.closeFd(this.src); this.src = -1; } this.dir = false; }
	Dispose(): void { this.close(); }
	MoveFrom(o: IFStream): void {
		this.src = o.src; this.srcPos = o.srcPos; this.buf = o.buf; this.pos = o.pos; this.len = o.len; this.dir = o.dir;
		o.src = -1; o.dir = false;
	}
}

/** std::fstream as the C# port has it (C# Cpp.FStream): the file opened, or created, for reading and writing
 *  (FileMode.OpenOrCreate, not truncated) and written from its start through a FileStream with the default 4 KiB
 *  buffer. */
export class FStream extends OStream {
	constructor(path: cpp.Str, mode: number) {
		super();
		try {
			const fd = FsNet.open(FsNet.s(path), FsNet.OPEN_OR_CREATE_RW);
			try { this.s = new FileOut(fd, 4096, false); }
			catch (e) { FsNet.closeFd(fd); throw e; }
		} catch (e) {
			this.failbit = true;
		}
	}
	is_open(): boolean { return this.s != null; }
	close(): void { if (this.s != null) { const f = this.s; this.s = null; f.close(); } }
	Dispose(): void { this.close(); }
}

/** std::cout, std::cerr, std::clog, std::getline and the std::setprecision / setw / setfill values (C# Cpp.Streams).
 *  cout and cerr write through the C stdio files R.stdout_ and R.stderr_, each write flushed. */
export class Streams {
	static readonly cout: OStream = OStream.Std(1);
	static readonly cerr: OStream = OStream.Std(2);
	static readonly clog: OStream = Streams.cerr;
	static getline_IStream_Str(s: IStream, line: cpp.Str): IStream { s.ReadLine(line, 10); return s; }
	static getline_IStream_Str_c(s: IStream, line: cpp.Str, delim: number): IStream { s.ReadLine(line, delim & 0xFF); return s; }
	static getline_IStream_Str_i(s: IStream, line: cpp.Str, delim: number): IStream { s.ReadLine(line, delim & 0xFF); return s; }
	static setprecision(n: number): SetPrec { return new SetPrec(n); }
	static setw(n: number): SetW { return new SetW(n); }
	static setfill(c: number): SetFill { return new SetFill(c); }
}
