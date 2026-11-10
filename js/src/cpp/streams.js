// streams.js - the iostreams the engine uses (C# cs/runtime/Streams.cs), with libstdc++'s formatting: a double is
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
import { FsNet, FileOut, MemStream } from './fsnet.js';

const EMPTY = new Uint8Array(0);

/** The libstdc++ values of ios_base::openmode, seekdir, fmtflags and iostate (C# Cpp.Ios). */
export class Ios {
	static in = 8;
	static out = 16;
	static binary = 4;
	static app = 1;
	static trunc = 32;
	static ate = 2;
	static beg = 0;
	static cur = 1;
	static end = 2;
	static boolalpha = 1;
	static dec = 2;
	static fixed = 4;
	static hex = 8;
	static internal = 16;
	static left = 32;
	static oct = 64;
	static right = 128;
	static scientific = 256;
	static showbase = 512;
	static showpoint = 1024;
	static showpos = 2048;
	static skipws = 4096;
	static unitbuf = 8192;
	static uppercase = 16384;
	static adjustfield = 176;
	static basefield = 74;
	static floatfield = 260;
	static goodbit = 0;
	static badbit = 1;
	static eofbit = 2;
	static failbit = 4;
}

/** The values std::setprecision, std::setw and std::setfill return. */
export class SetPrec { n; constructor(n) { this.n = n; } }
export class SetW { n; constructor(n) { this.n = n; } }
export class SetFill { c; constructor(c) { this.c = c; } }

function i32(x) { return typeof x === 'bigint' ? Number(BigInt.asIntN(32, x)) : x | 0; }
function num(x) { return typeof x === 'bigint' ? Number(x) : x; }

/** The state and format part of std::ios_base (C# Cpp.IosBase). */
export class IosBase {
	failbit = false;
	eofbit = false;
	badbit = false;
	prec = 6;
	flagsv = 0;
	widthv = 0;
	fillc = 32;

	good() { return !this.failbit && !this.eofbit && !this.badbit; }
	fail() { return this.failbit || this.badbit; }
	bad() { return this.badbit; }
	eof() { return this.eofbit; }
	ok() { return !this.fail(); }
	notok() { return this.fail(); }
	/** clear(state): as in the C# port, every flag is reset whatever the argument. */
	clear(s = 0) { this.failbit = this.eofbit = this.badbit = false; }
	precision_() { return this.prec; }
	precision_l(p) { const o = this.prec; this.prec = p; return o; }
	width_() { return this.widthv; }
	width_l(w) { const o = this.widthv; this.widthv = w; return o; }
	fill_() { return this.fillc; }
	fill_i(c) { const o = this.fillc; this.fillc = c; return o; }
	setf_i(f) { const o = this.flagsv; this.flagsv |= f; return o; }
	setf_i_i(f, mask) { const o = this.flagsv; this.flagsv = (this.flagsv & ~mask) | (f & mask); return o; }
	unsetf(f) { this.flagsv &= ~f; }
	rdbuf() { return null; }
	imbue(l) { }
	exceptions(m) { }
}

// the printf formats of libstdc++'s __num_base::_S_format_float: [showpoint][g, f, e, a], made on first use
let floatFmts = null;
function floatFmt(showpoint, k) {
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
	s = null;
	/** The in-memory bytes (the C# mem). */
	mem = null;
	/** 1 = standard output, 2 = standard error (the C# s, when it is a console stream). */
	std = 0;

	/** cout (1) and cerr (2). */
	static Std(fd) { const o = new OStream(); o.std = fd; return o; }

	stdFile() { return this.std === 1 ? cpp.R.stdout_ : cpp.R.stderr_; }

	/** (s ?? mem)?.Write(b, off, n). */
	Raw(b, off, n) {
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
	Pad(body, off, n) {
		const w = num(this.widthv);
		this.widthv = 0;
		if (n >= w) { this.Raw(body, off, n); return; }
		const pad = new Uint8Array(w - n).fill(this.fillc & 0xFF);
		if ((this.flagsv & Ios.left) !== 0) { this.Raw(body, off, n); this.Raw(pad, 0, pad.length); }
		else { this.Raw(pad, 0, pad.length); this.Raw(body, off, n); }
	}
	PadAll(body) { this.Pad(body, 0, body.length); }

	Put_Str(x) { this.Pad((x).b, 0, (x).n); return this; }
	Put_CPtr(x) { const p = x; this.Pad(p.B, p.O, FsNet.clen(p)); return this; }
	Put_c(c) { this.PadAll([c & 0xFF]); return this; }
	Put_uc(c) { this.PadAll([c & 0xFF]); return this; }
	Put_i(v) { this.PadAll(FsNet.bytesOf(String(v))); return this; }
	Put_l(v) { this.PadAll(FsNet.bytesOf(String(v))); return this; }
	Put_u(v) { this.PadAll(FsNet.bytesOf(String(v))); return this; }
	Put_ul(v) { this.PadAll(FsNet.bytesOf(String(v))); return this; }
	Put_s(v) { return this.Put_i(v); }
	Put_b(v) { this.PadAll(FsNet.bytesOf((this.flagsv & Ios.boolalpha) !== 0 ? (v ? 'true' : 'false') : (v ? '1' : '0'))); return this; }
	Put_f(v) { return this.Put_d(v); }

	/** operator<<(double): the conversion letter from the floatfield, '#' for showpoint, the precision. */
	Put_d(v) {
		const fx = (this.flagsv & Ios.fixed) !== 0, sci = (this.flagsv & Ios.scientific) !== 0;
		const sp = (this.flagsv & Ios.showpoint) !== 0;
		const body = fx && sci ? cpp.R.Format(floatFmt(sp, 3), [v])
			: cpp.R.Format(floatFmt(sp, fx ? 1 : sci ? 2 : 0), [i32(this.prec), v]);
		this.PadAll(body);
		return this;
	}

	Put_SetPrec(p) { this.prec = p.n; return this; }
	Put_SetW(w) { this.widthv = w.n; return this; }
	Put_SetFill(f) { this.fillc = f.c; return this; }
	Put_OStream(o) { return this; }
	Manip_endl() { this.Raw([10], 0, 1); this.flush(); return this; }
	Manip_flush() { this.flush(); return this; }
	Manip_setprecision(n) { this.prec = n; return this; }
	Manip_setw(n) { this.widthv = n; return this; }
	Manip_setfill(c) { this.fillc = c; return this; }

	/** std::quoted(s): s between double quotes, with every '"' and '\\' escaped by a backslash; the width applies
	 *  to the whole quoted string, as in libstdc++ (__ostream_insert of the built string). */
	Manip_quoted_Str(x) {
		const xb = (x).b, xn = (x).n;
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
	Manip_quoted_CPtr(x) { return this.Manip_quoted_Str(cpp.Str.new_CPtr(x)); }
	Manip_fixed() { this.flagsv = (this.flagsv & ~(Ios.fixed | Ios.scientific)) | Ios.fixed; return this; }
	Manip_scientific() { this.flagsv = (this.flagsv & ~(Ios.fixed | Ios.scientific)) | Ios.scientific; return this; }
	Manip_defaultfloat() { this.flagsv &= ~(Ios.fixed | Ios.scientific); return this; }
	Manip_left() { this.flagsv = (this.flagsv & ~(Ios.left | Ios.right)) | Ios.left; return this; }
	Manip_right() { this.flagsv = (this.flagsv & ~(Ios.left | Ios.right)) | Ios.right; return this; }
	Manip_boolalpha() { this.flagsv |= Ios.boolalpha; return this; }
	Manip_noboolalpha() { this.flagsv &= ~Ios.boolalpha; return this; }
	Manip_showpoint() { this.flagsv |= Ios.showpoint; return this; }
	Manip_noshowpoint() { this.flagsv &= ~Ios.showpoint; return this; }

	/** write(p, n): n raw bytes (none, even at a null pointer, for n = 0: os.write(v.data(), 0) of an empty vector). */
	write_CPtr_l(p, n) { const q = p; if (n != 0) this.Raw(q.B, q.O, i32(n)); return this; }

	// write((const char*)p, n) of an array of numbers: its first n bytes (Mem.BytesOf)
	writePod(p, n, t) { const b = FsNet.podOf(p, i32(n), t); this.Raw(b, 0, b.length); return this; }
	write_PtrT_l__c(p, n) { return this.writePod(p, n, 'c'); }
	write_PtrT_l__uc(p, n) { return this.writePod(p, n, 'uc'); }
	write_PtrT_l__b(p, n) { return this.writePod(p, n, 'b'); }
	write_PtrT_l__s(p, n) { return this.writePod(p, n, 's'); }
	write_PtrT_l__us(p, n) { return this.writePod(p, n, 'us'); }
	write_PtrT_l__i(p, n) { return this.writePod(p, n, 'i'); }
	write_PtrT_l__u(p, n) { return this.writePod(p, n, 'u'); }
	write_PtrT_l__l(p, n) { return this.writePod(p, n, 'l'); }
	write_PtrT_l__ul(p, n) { return this.writePod(p, n, 'ul'); }
	write_PtrT_l__f(p, n) { return this.writePod(p, n, 'f'); }
	write_PtrT_l__d(p, n) { return this.writePod(p, n, 'd'); }

	/** s?.Flush(): a file's buffer reaches the file; the console streams write through at once. */
	flush() {
		if (this.s != null) this.s.flush();
		else if (this.std !== 0) cpp.R.fflush(this.stdFile());
		return this;
	}

	/** The put position: the file's (with what is buffered), the MemoryStream's, 0 with neither. */
	tellp() {
		if (this.s != null) return this.s.position();
		if (this.std !== 0) throw new cpp.SysException('NotSupportedException', 'Stream does not support seeking.');
		return this.mem != null ? this.mem.pos : 0;
	}

	seekp(pos, dir = Ios.beg) {
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
	static new_Str(init) {
		const o = new OStringStream();
		o.mem.write((init).b, 0, (init).n);
		o.mem.pos = 0;
		return o;
	}
	static new_i(mode) { return new OStringStream(); }

	/** str(): the whole MemoryStream. */
	str_() { const b = this.mem.toArray(); return FsNet.strOf(b, 0, b.length); }

	/** str(x): the contents replaced by x, the put position at its end. */
	str_Str(x) { this.mem = new MemStream(); this.mem.write((x).b, 0, (x).n); }

	/** The move assignment: the bytes, the precision and the flags (the source is left empty). */
	MoveFrom(o) { this.mem = o.mem; this.prec = o.prec; this.flagsv = o.flagsv; o.mem = new MemStream(); }
}

/** std::ofstream over a FileStream with a 64 KiB buffer (C# Cpp.OFStream): ios::app appends (FileMode.Append),
 *  any other mode creates or truncates (FileMode.Create); a file that cannot be opened leaves the stream closed with
 *  failbit set. Dispose is the destructor, which closes the file; a stream that is never closed keeps its buffered
 *  bytes, as the C# FileStream does at exit. */
export class OFStream extends OStream {
	static new_Str_i(path, mode = Ios.out) { const f = new OFStream(); f.open_Str_i(path, mode); return f; }
	static new_CPtr_i(path, mode = Ios.out) { const f = new OFStream(); f.open_Str_i(cpp.Str.new_CPtr(path), mode); return f; }
	static new_FsPath_i(path, mode = Ios.out) { const f = new OFStream(); f.open_Str_i(path.p, mode); return f; }

	open_Str_i(path, mode = Ios.out) {
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
	open_FsPath_i(path, mode = Ios.out) { this.open_Str_i(path.p, mode); }

	is_open() { return this.s != null; }
	close() { if (this.s != null) { const f = this.s; this.s = null; f.close(); } }
	/** ~basic_ofstream closes the file. */
	Dispose() { this.close(); }
	MoveFrom(o) { this.s = o.s; o.s = null; }
}

/** std::istream as the C# port has it (C# Cpp.IStream): a buffer of bytes (the whole string of an istringstream, or
 *  the last block of up to 64 KiB read from an ifstream's file) and the read position in it. A double is extracted
 *  by libstdc++'s num_get rules (Get_dr); the other formatted extractions read one whitespace-delimited token and
 *  convert it with strtol (a token that does not convert whole sets failbit and stores 0; an int out of range stores
 *  the nearest limit). getline consumes the delimiter; at the end of the input it sets eof, and fail too when
 *  nothing at all was read. An ifstream on a directory fails its first read with badbit and failbit, not eofbit
 *  (dir, AtEnd). seekg clears eof; on a file, ios::cur is relative to the logical read position. */
export class IStream extends IosBase {
	buf = EMPTY;
	pos = 0;
	len = 0;
	/** The file descriptor an ifstream reads (the C# src), or -1. */
	src = -1;
	/** The file offset just past the bytes read from src (FileStream.Position). */
	srcPos = 0;
	gcountv = 0;
	/** An ifstream opened on a directory: libstdc++ opens it (open(2) of a directory for reading succeeds) and the
	 *  first read fails with EISDIR, which basic_filebuf::underflow throws as ios_base::failure and the extraction
	 *  catches: badbit and failbit, not eofbit (C# Cpp.IStream.dir). */
	dir = false;

	Fill() {
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
	AtEnd() { if (!this.dir) this.eofbit = true; }
	peek() { if (!this.Fill()) { this.AtEnd(); return -1; } return this.buf[this.pos]; }
	get_() { if (!this.Fill()) { this.AtEnd(); this.failbit = true; return -1; } this.gcountv = 1; return this.buf[this.pos++]; }
	get_cr(c) { const x = this.get_(); if (x >= 0) c.set((x << 24) >> 24); return this; }
	ignore(n = 1, delim = -1) {
		const m = num(n);
		for (let i = 0; i < m; i++) { const c = this.get_(); if (c < 0 || c === delim) break; }
		this.failbit = this.failbit && !this.eofbit;
		return this;
	}
	gcount() { return this.gcountv; }

	/** read(p, n): up to n bytes; fewer set eof and fail. gcount is the number read. */
	read_CPtr_l(p, n) {
		const q = p;
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
	readPod(p, n, t) {
		const tmp = new Uint8Array(num(n));
		this.read_CPtr_l(new cpp.CPtr(tmp, 0), n);
		FsNet.podInto(p, tmp, 0, num(this.gcountv), t);
		return this;
	}
	read_PtrT_l__c(p, n) { return this.readPod(p, n, 'c'); }
	read_PtrT_l__uc(p, n) { return this.readPod(p, n, 'uc'); }
	read_PtrT_l__b(p, n) { return this.readPod(p, n, 'b'); }
	read_PtrT_l__s(p, n) { return this.readPod(p, n, 's'); }
	read_PtrT_l__us(p, n) { return this.readPod(p, n, 'us'); }
	read_PtrT_l__i(p, n) { return this.readPod(p, n, 'i'); }
	read_PtrT_l__u(p, n) { return this.readPod(p, n, 'u'); }
	read_PtrT_l__l(p, n) { return this.readPod(p, n, 'l'); }
	read_PtrT_l__ul(p, n) { return this.readPod(p, n, 'ul'); }
	read_PtrT_l__f(p, n) { return this.readPod(p, n, 'f'); }
	read_PtrT_l__d(p, n) { return this.readPod(p, n, 'd'); }

	/** getline(s, line, delim): the bytes up to the delimiter (consumed, not stored). */
	ReadLine(s, delim) {
		const str = s;
		str.clear();
		let any = false;
		for (;;) {
			if (!this.Fill()) { this.AtEnd(); if (!any) this.failbit = true; return any; }
			any = true;
			let k = this.pos;
			const b = this.buf, len = this.len;
			if (delim >= 0 && delim <= 255) { while (k < len && b[k] !== delim) k++; }
			else k = len;
			if (k > this.pos) str.append_CPtr_ul(new cpp.CPtr(b, this.pos), k - this.pos);
			if (k < len) { this.pos = k + 1; return true; }
			this.pos = len;
		}
	}

	static ws(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12; }

	SkipWs() { while (this.Fill() && IStream.ws(this.buf[this.pos])) this.pos++; }

	Token() {
		this.SkipWs();
		const t = new cpp.Str();
		while (this.Fill() && !IStream.ws(this.buf[this.pos])) t.push_back(this.buf[this.pos++]);
		if (t.n === 0) { this.failbit = true; if (!this.Fill()) this.AtEnd(); }
		else if (!this.Fill()) this.AtEnd();
		return t;
	}

	Get_Str(s) { const t = this.Token(); if (t.n > 0) (s).Assign_Str(t); return this; }

	/** is >> std::ws: skip whitespace (eof is set if the input ends there, failbit is not). */
	Manip_ws() {
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
	Get_dr(v) {
		if (!this.good()) { this.failbit = true; return this; }     // the sentry: a stream not good extracts nothing
		this.SkipWs();
		if (!this.Fill()) { this.AtEnd(); this.failbit = true; return this; }
		const acc = [];
		let more = true;
		let c = this.buf[this.pos];
		// the next character (-1, and more false, at the end of the input)
		const next = () => { this.pos++; more = this.Fill(); return more ? this.buf[this.pos] : -1; };
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
		const r = new cpp.Cell(0);
		const n = cpp.R.ScanDouble(a, 0, 2147483647, r, false);
		if (n === 0 || a[n] !== 0) { v.set(0); this.failbit = true; }
		else if (r.v === Infinity) { v.set(1.7976931348623157e308); this.failbit = true; }
		else if (r.v === -Infinity) { v.set(-1.7976931348623157e308); this.failbit = true; }
		else v.set(r.v);
		return this;
	}
	Get_fr(v) { const d = new cpp.Cell(0); this.Get_dr(d); v.set(Math.fround(d.v)); return this; }
	Get_ir(v) {
		const t = this.Token();
		if (t.n === 0) { v.set(0); return this; }
		const p = t.c_str();
		const end = new cpp.Cell(p);
		const r = cpp.R.strtol(p, end, 10);
		if ((end.v).O !== t.n || r < -2147483648 || r > 2147483647) {
			this.failbit = true;
			v.set(r < -2147483648 ? -2147483648 : r > 2147483647 ? 2147483647 : 0);
			return this;
		}
		v.set(Number(r));
		return this;
	}
	Get_lr(v) {
		const t = this.Token();
		if (t.n === 0) { v.set(0); return this; }
		const p = t.c_str();
		const end = new cpp.Cell(p);
		const r = cpp.R.strtol(p, end, 10);
		if ((end.v).O !== t.n) { this.failbit = true; v.set(0); return this; }
		v.set(r);
		return this;
	}
	Get_ulr(v) { const x = new cpp.Cell(0); this.Get_lr(x); v.set(cpp.L.toU64(x.v)); return this; }
	Get_ur(v) { const x = new cpp.Cell(0); this.Get_lr(x); v.set(cpp.L.toU32(x.v)); return this; }
	Get_cr(c) { this.SkipWs(); const x = this.get_(); if (x >= 0) c.set((x << 24) >> 24); return this; }

	/** The read position: the file offset of the next byte, or the index in the string. */
	tellg() { return this.src >= 0 ? this.srcPos - (this.len - this.pos) : this.pos; }

	seekg(off, dir = Ios.beg) {
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
	static new_Str(s) { const r = new IStringStream(); r.str_Str(s); return r; }
	static new_Str_i(s, mode) { const r = new IStringStream(); r.str_Str(s); return r; }

	/** str(x): a copy of x to read from the start; fail and eof are cleared. */
	str_Str(s) {
		this.buf = FsNet.copyOf((s).b, 0, (s).n);
		this.pos = 0;
		this.len = this.buf.length;
		this.failbit = this.eofbit = false;
	}
	str_() { return FsNet.strOf(this.buf, 0, this.len); }
	MoveFrom(o) { this.buf = o.buf; this.pos = o.pos; this.len = o.len; }
}

/** std::ifstream over a FileStream (C# Cpp.IFStream): a missing file leaves the stream closed with failbit set; a
 *  directory opens, as libstdc++ opens it, and every read then fails (IStream.dir). Dispose is the destructor, which
 *  closes the file. */
export class IFStream extends IStream {
	static new_Str_i(path, mode = Ios.in) { const f = new IFStream(); f.open_Str_i(path, mode); return f; }
	static new_CPtr_i(path, mode = Ios.in) { const f = new IFStream(); f.open_Str_i(cpp.Str.new_CPtr(path), mode); return f; }
	static new_FsPath_i(path, mode = Ios.in) { const f = new IFStream(); f.open_Str_i(path.p, mode); return f; }

	open_Str_i(path, mode = Ios.in) {
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
	open_FsPath_i(path, mode = Ios.in) { this.open_Str_i(path.p, mode); }
	is_open() { return this.src >= 0 || this.dir; }
	close() { if (this.src >= 0) { FsNet.closeFd(this.src); this.src = -1; } this.dir = false; }
	Dispose() { this.close(); }
	MoveFrom(o) {
		this.src = o.src; this.srcPos = o.srcPos; this.buf = o.buf; this.pos = o.pos; this.len = o.len; this.dir = o.dir;
		o.src = -1; o.dir = false;
	}
}

/** std::fstream as the C# port has it (C# Cpp.FStream): the file opened, or created, for reading and writing
 *  (FileMode.OpenOrCreate, not truncated) and written from its start through a FileStream with the default 4 KiB
 *  buffer. */
export class FStream extends OStream {
	constructor(path, mode) {
		super();
		try {
			const fd = FsNet.open(FsNet.s(path), FsNet.OPEN_OR_CREATE_RW);
			try { this.s = new FileOut(fd, 4096, false); }
			catch (e) { FsNet.closeFd(fd); throw e; }
		} catch (e) {
			this.failbit = true;
		}
	}
	is_open() { return this.s != null; }
	close() { if (this.s != null) { const f = this.s; this.s = null; f.close(); } }
	Dispose() { this.close(); }
}

/** std::cout, std::cerr, std::clog, std::getline and the std::setprecision / setw / setfill values (C# Cpp.Streams).
 *  cout and cerr write through the C stdio files R.stdout_ and R.stderr_, each write flushed. */
export class Streams {
	static cout = OStream.Std(1);
	static cerr = OStream.Std(2);
	static clog = Streams.cerr;
	static getline_IStream_Str(s, line) { s.ReadLine(line, 10); return s; }
	static getline_IStream_Str_c(s, line, delim) { s.ReadLine(line, delim & 0xFF); return s; }
	static getline_IStream_Str_i(s, line, delim) { s.ReadLine(line, delim & 0xFF); return s; }
	static setprecision(n) { return new SetPrec(n); }
	static setw(n) { return new SetW(n); }
	static setfill(c) { return new SetFill(c); }
}
// (ts/src/cpp/streams.ts without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)
