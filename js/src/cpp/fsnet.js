// fsnet.js - the parts of .NET's System.IO that cs/runtime/Streams.cs and Fs.cs rely on, reproduced over Node's
// synchronous fs API for the TypeScript port of those files (as java/src/cpp/FsNet.java does for Java):
// Path.GetFullPath on Unix (lexical: "." and ".." and doubled separators removed against the current directory,
// symbolic links left alone), File.Exists / Directory.Exists (stat, then lstat for a broken link; a full path ending
// in '/' is never a file), File.Move / File.Copy / File.Delete / Directory.Delete / Directory.CreateDirectory,
// new FileInfo(p).Length, a FileStream's write buffer (BufferedFileStreamStrategy: fill the buffer, flush it, write a
// request of a whole buffer or more directly) and position, a read-only FileStream, and a MemoryStream. Every path
// is made full first, as .NET does, so "a/../b" names "b" even when "a" does not exist. Paths reach the OS as .NET
// passes them: the C# string of the bytes (Latin-1) encoded as UTF-8, which is what Node does with a string path.
// Also the byte helpers the stream classes share: Latin-1 strings, copies between byte arrays of either kind
// (Uint8Array or number[]), and the byte view of a Ptr<T> (C#'s MemoryMarshal.AsBytes, little-endian).
// Runtime part D (cs/runtime/Streams.cs, Fs.cs). Nothing here runs at module load but the class definitions.
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

import * as fs from 'node:fs';
import * as cpp from './index.js';

/** A byte array as the runtime holds one (CPtr.B, Str.b, R.Format's result): a Uint8Array or a number[]. */


const SEEK_BEFORE_BEGIN = 'An attempt was made to move the position before the beginning of the stream.';
const SEEK_APPEND = 'Unable seek backward to overwrite data that previously existed in a file opened in Append mode.';

function errCode(e) { return e != null && typeof e.code === 'string' ? e.code : ''; }
function errMsg(e) { return e != null && e.message != null ? String(e.message) : String(e); }

export class FsNet {
	static io(msg) { return new cpp.SysException('IO.IOException', msg); }
	static ioErr(e) { return new cpp.SysException('IO.IOException', errMsg(e)); }

	// ------------------------------------------------------------------------------------------- bytes

	/** The Latin-1 string of n bytes (C#'s Encoding.Latin1.GetString, Str.ToString()). */
	static latin1(b, off, n) {
		let s = '';
		for (let i = 0; i < n; i += 4096) {
			const m = Math.min(4096, n - i);
			const a = new Array(m);
			for (let k = 0; k < m; k++) a[k] = b[off + i + k] & 0xFF;
			s += String.fromCharCode.apply(null, a);
		}
		return s;
	}

	/** The bytes of a string, one per character (its low 8 bits: C#'s (byte)c, as R.Lit makes them). */
	static bytesOf(s) {
		const b = new Uint8Array(s.length);
		for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
		return b;
	}

	/** The C# string of a Str (Latin-1). */
	static s(x) { return FsNet.latin1(x.b, 0, x.n); }

	/** The C# string of a NUL-terminated char* (R.Str). */
	static cstr(p) {
		const b = p.B;
		let i = p.O;
		while (b[i] !== 0) i++;
		return FsNet.latin1(b, p.O, i - p.O);
	}

	/** strlen. */
	static clen(p) {
		const b = p.B;
		let i = p.O;
		while (b[i] !== 0) i++;
		return i - p.O;
	}

	/** A Str of n bytes of src from off (C#'s new Str(byte[], off, n)). */
	static strOf(src, off, n) {
		const r = new cpp.Str();
		if (n > 0) r.append_CPtr_ul(new cpp.CPtr(src, off), n);
		return r;
	}

	/** A Str of the bytes of a string (C#'s new Str(string)). */
	static str(x) { const b = FsNet.bytesOf(x); return FsNet.strOf(b, 0, b.length); }

	/** The bytes [off, off + n) of b as a Uint8Array (a view when b is one, a copy otherwise). */
	static u8(b, off, n) {
		if (b instanceof Uint8Array) return b.subarray(off, off + n);
		const r = new Uint8Array(n);
		for (let i = 0; i < n; i++) r[i] = b[off + i];
		return r;
	}

	/** A fresh copy of n bytes of b from off. */
	static copyOf(b, off, n) {
		if (b instanceof Uint8Array) return b.slice(off, off + n);
		return FsNet.u8(b, off, n);
	}

	/** Array.Copy(src, so, dst, d, n) of bytes (overlap-safe, as Array.Copy is). */
	static copy(src, so, dst, d, n) {
		if (n <= 0) return;
		if ((src) === dst) { (dst).copyWithin(d, so, so + n); return; }
		if (dst instanceof Uint8Array && src instanceof Uint8Array) { dst.set(src.subarray(so, so + n), d); return; }
		for (let i = 0; i < n; i++) dst[d + i] = src[so + i] & 0xFF;
	}

	// ------------------------------------------------------------------------------------------- Ptr<T> as bytes

	/** The size of an element of type code t (the translator's codes: c uc s us i u l ul f d b). */
	static podSize(t) {
		switch (t) {
			case 'c': case 'uc': case 'b': return 1;
			case 's': case 'us': return 2;
			case 'i': case 'u': case 'f': return 4;
			case 'l': case 'ul': case 'd': return 8;
		}
		throw new cpp.SysException('NotSupportedException', 'no byte view of type ' + t);
	}

	static podPut(v, at, t, x) {
		switch (t) {
			case 'c': v.setInt8(at, Number(x)); return;
			case 'uc': v.setUint8(at, Number(x)); return;
			case 'b': v.setUint8(at, x ? 1 : 0); return;
			case 's': v.setInt16(at, Number(x), true); return;
			case 'us': v.setUint16(at, Number(x), true); return;
			case 'i': v.setInt32(at, Number(x), true); return;
			case 'u': v.setUint32(at, Number(x), true); return;
			case 'f': v.setFloat32(at, x, true); return;
			case 'd': v.setFloat64(at, x, true); return;
			case 'l': v.setBigInt64(at, BigInt(x), true); return;
			case 'ul': v.setBigUint64(at, BigInt(x), true); return;
		}
	}

	static podGet(v, at, t) {
		switch (t) {
			case 'c': return v.getInt8(at);
			case 'uc': return v.getUint8(at);
			case 'b': return v.getUint8(at) !== 0;
			case 's': return v.getInt16(at, true);
			case 'us': return v.getUint16(at, true);
			case 'i': return v.getInt32(at, true);
			case 'u': return v.getUint32(at, true);
			case 'f': return v.getFloat32(at, true);
			case 'd': return v.getFloat64(at, true);
			case 'l': { const r = v.getBigInt64(at, true); return r >= -9007199254740991n && r <= 9007199254740991n ? Number(r) : r; }
			case 'ul': { const r = v.getBigUint64(at, true); return r <= 9007199254740991n ? Number(r) : r; }
		}
		return 0;
	}

	/** The number of elements of p that n bytes touch; ArgumentOutOfRange past the array's end (the C# Span
	 *  slice over p.a from p.o). */
	static podCount(a, o, n, sz) {
		const k = Math.ceil(n / sz);
		if (n < 0 || a == null || o < 0 || o + k > a.length)
			throw new cpp.SysException('ArgumentOutOfRangeException', 'Specified argument was out of the range of valid values.');
		return k;
	}

	/** Mem.BytesOf(p, n): the first n bytes of the elements from p (little-endian, as MemoryMarshal.AsBytes). */
	static podOf(p, n, t) {
		if (n <= 0) return new Uint8Array(0);
		const sz = FsNet.podSize(t), a = p.a, o = Number(p.o);
		const k = FsNet.podCount(a, o, n, sz);
		const bytes = new Uint8Array(k * sz);
		const view = new DataView(bytes.buffer);
		for (let j = 0; j < k; j++) FsNet.podPut(view, j * sz, t, a[o + j]);
		return bytes.subarray(0, n);
	}

	/** Mem.BytesInto(p, src, off, n): the first n bytes of the elements from p replaced by src[off, off + n) (a
	 *  last element they cover only in part keeps its other bytes). */
	static podInto(p, src, off, n, t) {
		if (n <= 0) return;
		const sz = FsNet.podSize(t), a = p.a, o = Number(p.o);
		const k = FsNet.podCount(a, o, n, sz);
		const bytes = new Uint8Array(k * sz);
		FsNet.copy(src, off, bytes, 0, n);
		const view = new DataView(bytes.buffer);
		const part = n % sz;
		if (part !== 0) {
			const last = new DataView(new ArrayBuffer(8));
			FsNet.podPut(last, 0, t, a[o + k - 1]);
			for (let i = part; i < sz; i++) bytes[(k - 1) * sz + i] = last.getUint8(i);
		}
		for (let j = 0; j < k; j++) a[o + j] = FsNet.podGet(view, j * sz, t);
	}

	// ------------------------------------------------------------------------------------------- Path.GetFullPath

	/** Directory.GetCurrentDirectory: getcwd(3). */
	static cwd() { return process.cwd(); }

	/** Path.GetFullPath on Unix: ArgumentException for an empty path or a NUL; a relative path is put under the
	 *  current directory (Path.Combine), then PathInternal.RemoveRelativeSegments collapses it. */
	static fullPath(path) {
		if (path.length === 0) throw new cpp.SysException('ArgumentException', "The value cannot be an empty string. (Parameter 'path')");
		if (path.indexOf('\0') >= 0) throw new cpp.SysException('ArgumentException', "Null character in path. (Parameter 'path')");
		if (path.charCodeAt(0) !== 47) {
			const c = FsNet.cwd();
			path = c.endsWith('/') ? c + path : c + '/' + path;
		}
		const r = FsNet.removeRelativeSegments(path, 1);
		return r.length === 0 ? '/' : r;
	}

	/** PathInternal.RemoveRelativeSegments (dotnet/runtime) for '/' separators. */
	static removeRelativeSegments(path, rootLength) {
		let skip = rootLength;
		if (path.charAt(skip - 1) === '/') skip--;
		let sb = skip > 0 ? path.substring(0, skip) : '';
		const len = path.length;
		for (let i = skip; i < len; i++) {
			const c = path.charAt(i);
			if (c === '/' && i + 1 < len) {
				if (path.charAt(i + 1) === '/') continue;
				if ((i + 2 === len || path.charAt(i + 2) === '/') && path.charAt(i + 1) === '.') { i++; continue; }
				if (i + 2 < len && (i + 3 === len || path.charAt(i + 3) === '/') && path.charAt(i + 1) === '.' && path.charAt(i + 2) === '.') {
					let s;
					for (s = sb.length - 1; s >= skip; s--) {
						if (sb.charAt(s) === '/') {
							sb = sb.substring(0, (i + 3 >= len && s === skip) ? s + 1 : s);
							break;
						}
					}
					if (s < skip) sb = sb.substring(0, skip);
					i += 2;
					continue;
				}
			}
			sb += c;
		}
		if (skip !== rootLength && sb.length < rootLength) sb += path.charAt(rootLength - 1);
		return sb;
	}

	// ------------------------------------------------------------------------------------------- existence

	/** stat(2), or lstat(2) when stat fails (a broken link): null when nothing is there. */
	static stat(full) {
		try {
			const st = fs.statSync(full, { throwIfNoEntry: false });
			if (st) return st;
		} catch (e) { /* fall through to lstat */ }
		try {
			const st = fs.lstatSync(full, { throwIfNoEntry: false });
			return st ? st : null;
		} catch (e) { return null; }
	}

	/** FileSystem.FileExists of a full path: something that is not a directory. */
	static fsFileExists(full) {
		if (full.length > 1 && full.endsWith('/')) return false;
		const a = FsNet.stat(full);
		return a != null && !a.isDirectory();
	}

	static fsDirExists(full) {
		const a = FsNet.stat(full);
		return a != null && a.isDirectory();
	}

	/** System.IO.File.Exists. */
	static fileExists(path) {
		if (path == null || path.length === 0) return false;
		let f;
		try { f = FsNet.fullPath(path); } catch (e) { return false; }
		if (f.endsWith('/')) return false;
		return FsNet.fsFileExists(f);
	}

	/** System.IO.Directory.Exists. */
	static dirExists(path) {
		if (path == null || path.length === 0) return false;
		let f;
		try { f = FsNet.fullPath(path); } catch (e) { return false; }
		return FsNet.fsDirExists(f);
	}

	// ------------------------------------------------------------------------------------------- file operations

	/** File.Move(a, b, overwrite: true): only a file moves; rename(2), or copy and delete across file systems.
	 *  Throws SysException: FileNotFoundException for a missing source (or a missing name in an existing directory),
	 *  DirectoryNotFoundException for a missing destination directory, IOException otherwise. */
	static moveFile(a, b) {
		const fa = FsNet.fullPath(a), fb = FsNet.fullPath(b);
		if (!FsNet.fsFileExists(fa)) throw new cpp.SysException('IO.FileNotFoundException', "Could not find file '" + fa + "'.");
		try { FsNet.moveFull(fa, fb); }
		catch (e) {
			if (errCode(e) === 'ENOENT') {
				if (!FsNet.parentExists(fb)) throw new cpp.SysException('IO.DirectoryNotFoundException', "Could not find a part of the path '" + fb + "'.");
				throw new cpp.SysException('IO.FileNotFoundException', "Could not find file '" + fb + "'.");
			}
			throw FsNet.ioErr(e);
		}
	}

	/** FileSystem.MoveFile(fa, fb, overwrite: true) of two full paths: rename(2), or copy and delete across file
	 *  systems (EXDEV). Throws Node's error. */
	static moveFull(fa, fb) {
		try { fs.renameSync(fa, fb); }
		catch (e) {
			if (errCode(e) !== 'EXDEV') throw e;
			fs.copyFileSync(fa, fb);
			fs.unlinkSync(fa);
		}
	}

	/** Whether the directory of a full path exists (.NET tells a missing directory from a missing file). */
	static parentExists(full) {
		const k = full.lastIndexOf('/');
		return FsNet.fsDirExists(k <= 0 ? '/' : full.substring(0, k));
	}

	/** File.Copy(a, b) without overwrite: the bytes and the permission bits (copy_file_range and fchmod). */
	static copyFile(a, b) {
		const fa = FsNet.fullPath(a), fb = FsNet.fullPath(b);
		const st = FsNet.stat(fa);
		if (st != null && st.isDirectory()) throw new cpp.SysException('UnauthorizedAccessException', "Access to the path '" + fa + "' is denied.");
		try { fs.copyFileSync(fa, fb, fs.constants.COPYFILE_EXCL); }
		catch (e) { throw FsNet.ioErr(e); }
	}

	/** File.Delete of a full path known to be a file (or a link). */
	static deleteFile(full) {
		try { fs.unlinkSync(full); }
		catch (e) { if (errCode(e) !== 'ENOENT') throw FsNet.ioErr(e); }
	}

	/** Directory.Delete(path) (not recursive): rmdir(2). */
	static deleteDir(full) {
		try { fs.rmdirSync(full); } catch (e) { throw FsNet.ioErr(e); }
	}

	/** Directory.CreateDirectory: the directory and its missing parents; an existing directory is fine. */
	static createDirectories(path) {
		const f = FsNet.fullPath(path);
		try { fs.mkdirSync(f, { recursive: true }); } catch (e) { throw FsNet.ioErr(e); }
	}

	/** new FileInfo(path).Length: FileNotFoundException for a missing path or a directory. */
	static fileLength(path) {
		const f = FsNet.fullPath(path);
		const a = f.length > 1 && f.endsWith('/') ? null : FsNet.stat(f);
		if (a == null || a.isDirectory()) throw new cpp.SysException('IO.FileNotFoundException', "Could not find file '" + f + "'.");
		return a.size;
	}

	/** The FileStream constructor's open: the full path, a directory refused (UnauthorizedAccessException in .NET).
	 *  Returns the file descriptor; throws when the file cannot be opened. */
	static open(path, flags) {
		const full = FsNet.fullPath(path);
		if (full.length > 1 && full.endsWith('/')) throw FsNet.io('Is a directory');
		const fd = fs.openSync(full, flags, 0o666);
		let dir = false;
		try { dir = fs.fstatSync(fd).isDirectory(); } catch (e) { dir = false; }
		if (dir) { try { fs.closeSync(fd); } catch (e) { /* gone either way */ } throw FsNet.io('Is a directory'); }
		return fd;
	}

	/** FileMode.Open, FileAccess.Read. */
	static get READ() { return fs.constants.O_RDONLY; }
	/** FileMode.Create, FileAccess.Write (truncates). */
	static get CREATE() { return fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC; }
	/** FileMode.Append, FileAccess.Write: no O_APPEND; the stream starts at the end and may not seek before it. */
	static get APPEND() { return fs.constants.O_WRONLY | fs.constants.O_CREAT; }
	/** FileMode.OpenOrCreate, FileAccess.ReadWrite. */
	static get OPEN_OR_CREATE_RW() { return fs.constants.O_RDWR | fs.constants.O_CREAT; }

	static closeFd(fd) { try { fs.closeSync(fd); } catch (e) { /* the descriptor is gone either way */ } }

	static fdSize(fd) {
		try { return fs.fstatSync(fd).size; } catch (e) { throw FsNet.ioErr(e); }
	}

	/** One read(2) at a position (FileStream.Read of a buffer at least as large as its own: no copy through it). */
	static readAt(fd, b, off, n, pos) {
		try { return fs.readSync(fd, b, off, n, pos); } catch (e) { throw FsNet.ioErr(e); }
	}

	/** Write all n bytes at a position (pwrite until done, as RandomAccess.WriteAtOffset). */
	static writeAt(fd, b, off, n, pos) {
		let done = 0;
		try { while (done < n) done += fs.writeSync(fd, b, off + done, n - done, pos + done); }
		catch (e) { throw FsNet.ioErr(e); }
	}
}

// ------------------------------------------------------------------------------------------- FileStream (write)

/** A FileStream opened for writing, with its write buffer (BufferedFileStreamStrategy over the file). */
export class FileOut {
	fd;
	buf;
	/** bytes in buf */
	wpos = 0;
	/** the file offset buf starts at (OSFileStreamStrategy._filePosition) */
	fpos = 0;
	appendStart = -1;

	constructor(fd, bufferSize, append) {
		this.fd = fd;
		this.buf = new Uint8Array(bufferSize);
		if (append) { this.fpos = FsNet.fdSize(fd); this.appendStart = this.fpos; }
	}

	raw(b, off, n) {
		const u = FsNet.u8(b, off, n);
		FsNet.writeAt(this.fd, u, 0, n, this.fpos);
		this.fpos += n;
	}

	flushWrite() {
		if (this.wpos > 0) { const k = this.wpos; this.wpos = 0; this.raw(this.buf, 0, k); }
	}

	/** BufferedFileStreamStrategy.WriteSpan. */
	write(b, off, n) {
		const size = this.buf.length;
		if (this.wpos > 0) {
			const room = size - this.wpos;
			if (room > 0) {
				if (room >= n) { FsNet.copy(b, off, this.buf, this.wpos, n); this.wpos += n; return; }
				FsNet.copy(b, off, this.buf, this.wpos, room);
				this.wpos += room;
				off += room;
				n -= room;
			}
			this.flushWrite();
		}
		if (n >= size) { this.raw(b, off, n); return; }
		if (n === 0) return;
		FsNet.copy(b, off, this.buf, 0, n);
		this.wpos = n;
	}

	position() { return this.fpos + this.wpos; }

	length() { return Math.max(FsNet.fdSize(this.fd), this.fpos + this.wpos); }

	/** FileStream.Seek: the buffer flushed, then the new position (IOException before 0 or, in append mode, before
	 *  the end the file had when it was opened). dir: 0 begin, 1 current, 2 end. */
	seek(off, dir) {
		this.flushWrite();
		const np = dir === 0 ? off : dir === 2 ? this.length() + off : this.fpos + off;
		if (np < 0) throw FsNet.io(SEEK_BEFORE_BEGIN);
		if (this.appendStart !== -1 && np < this.appendStart) throw FsNet.io(SEEK_APPEND);
		this.fpos = np;
		return np;
	}

	flush() { this.flushWrite(); }

	close() {
		try { this.flushWrite(); }
		finally { FsNet.closeFd(this.fd); }
	}
}

// ------------------------------------------------------------------------------------------- MemoryStream

/** A MemoryStream: the bytes, their length and the position (writes overwrite, extend, and zero-fill a gap). */
export class MemStream {
	b = new Uint8Array(0);
	len = 0;
	pos = 0;

	write(src, off, n) {
		if (n <= 0) return;
		const end = this.pos + n;
		if (end > this.len) {
			if (end > this.b.length) {
				const nb = new Uint8Array(Math.max(Math.max(256, end), this.b.length * 2));
				nb.set(this.b.subarray(0, this.len));
				this.b = nb;
			}
			if (this.pos > this.len) this.b.fill(0, this.len, this.pos);
			this.len = end;
		}
		FsNet.copy(src, off, this.b, this.pos, n);
		this.pos = end;
	}

	toArray() { return this.b.slice(0, this.len); }

	seek(off, dir) {
		const np = dir === 0 ? off : dir === 1 ? this.pos + off : this.len + off;
		if (np < 0) throw FsNet.io(SEEK_BEFORE_BEGIN);
		if (np > 2147483647) throw new cpp.SysException('ArgumentOutOfRangeException', "Stream length must be non-negative and less than 2^31 - 1 - origin. (Parameter 'offset')");
		this.pos = np;
		return np;
	}
}
// (ts/src/cpp/fsnet.ts without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)
