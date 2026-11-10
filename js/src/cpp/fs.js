// fs.js - std::filesystem::path with POSIX paths, as libstdc++ on Linux, and the std::filesystem functions the engine
// calls (C# cs/runtime/Fs.cs: FsPath, Fs, FileStatus), over .NET's file system calls as the C# port makes them
// (fsnet.ts reproduces those): p holds the path's bytes; the element functions work on the text as the C# port's do
// (filename is the part after the last '/', "" when the path ends in '/'; operator/ adds a separator unless the
// right side is absolute or empty); canonical and weakly_canonical are Path.GetFullPath (lexical, links left
// alone), equivalent compares the two full paths, the error-code overloads set ENOENT (2), EACCES (13), EEXIST (17)
// or EISDIR (21) as the C# port does, and the plain overloads let .NET's exceptions through (as SysException).
// Overloaded C# methods carry the translator's parameter suffix (Join(FsPath) is Join_FsPath, exists(FsPath,
// ErrorCode) is exists_FsPath_ErrorCode); the constructors other than FsPath() are static factories (new_Str, ...).
// Runtime part D (cs/runtime/Fs.cs).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

import * as cpp from './index.js';
import { FsNet } from './fsnet.js';

/** path::compare as the C# port has it: the bytes, as std::string compares them (memcmp, then length). */
function cmpStr(a, b) {
	const m = Math.min(a.n, b.n);
	for (let i = 0; i < m; i++) {
		const x = a.b[i] & 0xFF, y = b.b[i] & 0xFF;
		if (x !== y) return x < y ? -1 : 1;
	}
	return a.n - b.n;
}

/** std::filesystem::path (C# Cpp.FsPath). */
export class FsPath {
	p;

	constructor() { this.p = new cpp.Str(); }
	static new_Str(s) { const r = new FsPath(); r.p = s.Clone(); return r; }
	static new_CPtr(s) { const r = new FsPath(); r.p = cpp.Str.new_CPtr(s); return r; }
	/** FsPath(string): a C# string (Latin-1). */
	static new_str(s) { const r = new FsPath(); r.p = FsNet.str(s); return r; }

	Clone() { return FsPath.new_Str(this.p); }
	clear() { this.p = new cpp.Str(); }
	/** ICopy.Assign (what a generic container calls). */
	Assign(o) { this.Assign_FsPath(o); }
	Assign_FsPath(o) { this.p = o.p.Clone(); }
	Assign_Str(s) { this.p = s.Clone(); }
	MoveFrom(o) { const q = o.p; o.p = new cpp.Str(); this.p = q; }
	CompareTo(o) { return cmpStr(this.p, o.p); }
	compare(o) { return cmpStr(this.p, o.p); }

	/** The C# string of the path (Latin-1). */
	S() { return FsNet.s(this.p); }
	toString() { return this.S(); }

	string() { return this.p.Clone(); }
	generic_string() { return this.p.Clone(); }
	native() { return this.p.Clone(); }
	c_str() { return this.p.c_str(); }
	u8string() { return this.p.Clone(); }
	empty() { return (this.p).n === 0; }
	is_absolute() { const q = this.p; return q.n > 0 && q.b[0] === 47; }
	is_relative() { return !this.is_absolute(); }
	has_filename() { return (this.filename().p).n > 0; }
	has_parent_path() { return (this.parent_path().p).n > 0; }
	has_extension() { return (this.extension().p).n > 0; }

	/** The last element (libstdc++: the part after the last '/'; "" when the path ends in '/'). */
	filename() {
		const s = this.S();
		const i = s.lastIndexOf('/');
		return FsPath.new_str(i < 0 ? s : s.substring(i + 1));
	}

	parent_path() {
		const s = this.S();
		const i = s.lastIndexOf('/');
		if (i < 0) return FsPath.new_str('');
		if (i === 0) return FsPath.new_str('/');
		let j = i;
		while (j > 0 && s.charAt(j - 1) === '/') j--;
		return FsPath.new_str(s.substring(0, j === 0 ? 1 : j));
	}

	stem() {
		const f = this.filename().S();
		if (f === '.' || f === '..') return FsPath.new_str(f);
		const i = f.lastIndexOf('.');
		return FsPath.new_str(i <= 0 ? f : f.substring(0, i));
	}

	extension() {
		const f = this.filename().S();
		if (f === '.' || f === '..') return FsPath.new_str('');
		const i = f.lastIndexOf('.');
		return FsPath.new_str(i <= 0 ? '' : f.substring(i));
	}

	/** replace_extension(ext): the extension removed, then ext added (with a '.' in front unless it has one); a
	 *  null or empty ext only removes. */
	replace_extension_FsPath(ext = null) {
		const e = this.extension().S();
		const all = this.S();
		let s = all.substring(0, all.length - e.length);
		if (ext != null && (ext.p).n > 0) s += ((ext.p).b[0] === 46 ? '' : '.') + ext.S();
		this.p = FsNet.str(s);
		return this;
	}
	replace_extension_Str(ext) { return this.replace_extension_FsPath(FsPath.new_Str(ext)); }
	replace_filename(f) { const par = this.parent_path(); this.p = par.Join_FsPath(f).p; return this; }
	remove_filename() { const s = this.S(); const i = s.lastIndexOf('/'); this.p = FsNet.str(i < 0 ? '' : s.substring(0, i + 1)); return this; }

	/** operator/ : an absolute right side replaces the path; otherwise a separator is added. */
	Join_FsPath(o) {
		if (o.is_absolute()) return o.Clone();
		let s = this.S();
		if (s.length === 0) return o.Clone();
		if (!s.endsWith('/') && (o.p).n > 0) s += '/';
		return FsPath.new_str(s + o.S());
	}
	Join_Str(o) { return this.Join_FsPath(FsPath.new_Str(o)); }
	Join_CPtr(o) { return this.Join_FsPath(FsPath.new_CPtr(o)); }

	/** Empty and "." elements dropped, ".." taking the element before it away (dropped at the root), a trailing
	 *  '/' kept, "." for an empty result. */
	lexically_normal() {
		const s = this.S();
		if (s.length === 0) return FsPath.new_str('');
		const abs = s.startsWith('/');
		const parts = [];
		for (const x of s.split('/')) {
			if (x === '' || x === '.') continue;
			if (x === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') { parts.pop(); continue; }
			if (x === '..' && abs) continue;
			parts.push(x);
		}
		let r = (abs ? '/' : '') + parts.join('/');
		if (s.endsWith('/') && parts.length > 0) r += '/';
		if (r === '') r = '.';
		return FsPath.new_str(r);
	}
}

/** std::filesystem::file_status as far as the engine asks (C# Cpp.FileStatus): not found, a regular file or a
 *  directory (File.Exists, then Directory.Exists, as .NET sees them: links followed). */
export class FileStatus {
	static NotFound = -1;
	static Regular = 1;
	static Directory = 2;
	static Other = 3;
	kind = 0;

	static Of(s) {
		const r = new FileStatus();
		r.kind = FsNet.fileExists(s) ? FileStatus.Regular : FsNet.dirExists(s) ? FileStatus.Directory : FileStatus.NotFound;
		return r;
	}
	type() { return this.kind; }
	Clone() { const r = new FileStatus(); r.kind = this.kind; return r; }
}

/** The std::filesystem functions (C# Cpp.Fs). */
export class Fs {
	static exists_FsPath(p) { const s = p.S(); return FsNet.fileExists(s) || FsNet.dirExists(s); }
	static exists_FsPath_ErrorCode(p, ec) { return Fs.exists_FsPath(p); }
	static exists_FileStatus(s) { return s.kind !== FileStatus.NotFound; }
	static is_regular_file_FsPath(p) { return FsNet.fileExists(p.S()); }
	static is_regular_file_FileStatus(s) { return s.kind === FileStatus.Regular; }
	static is_directory_FsPath(p) { return FsNet.dirExists(p.S()); }
	static is_directory_FileStatus(s) { return s.kind === FileStatus.Directory; }
	static is_symlink(s) { return false; }

	/** new FileInfo(p).Length: a missing file or a directory throws (FileNotFoundException). */
	static file_size_FsPath(p) { return FsNet.fileLength(p.S()); }

	/** file_size(p, ec): libstdc++ sets ENOENT for a missing file, EISDIR for a directory and returns
	 *  static_cast<uintmax_t>(-1) on error. */
	static file_size_FsPath_ErrorCode(p, ec) {
		const s = p.S();
		const e = ec;
		if (FsNet.fileExists(s)) { e.v = 0; return FsNet.fileLength(s); }
		e.v = FsNet.dirExists(s) ? 21 : 2;
		return 18446744073709551615n;
	}

	/** Removes a file (not a directory); reports whether one was removed. */
	static remove_FsPath(p) {
		const s = p.S();
		try { if (FsNet.fileExists(s)) { FsNet.deleteFile(FsNet.fullPath(s)); return true; } } catch (e) { /* false */ }
		return false;
	}

	/** remove(p, ec): a file or an empty directory (EACCES = 13 when that fails). */
	static remove_FsPath_ErrorCode(p, ec) {
		const e = ec;
		e.v = 0;
		const s = p.S();
		try {
			if (FsNet.fileExists(s)) { FsNet.deleteFile(FsNet.fullPath(s)); return true; }
			if (FsNet.dirExists(s)) { FsNet.deleteDir(FsNet.fullPath(s)); return true; }
		} catch (x) { e.v = 13; }
		return false;
	}

	/** Directory.CreateDirectory: true unless it fails (an existing directory is fine). */
	static create_directories_FsPath(p) {
		try { FsNet.createDirectories(p.S()); return true; } catch (e) { return false; }
	}
	static create_directories_FsPath_ErrorCode(p, ec) { (ec).v = 0; return Fs.create_directories_FsPath(p); }

	static current_path() { return FsPath.new_str(FsNet.cwd()); }
	static absolute(p) { return p.is_absolute() ? p.Clone() : Fs.current_path().Join_FsPath(p); }
	static canonical_FsPath(p) { return FsPath.new_str(FsNet.fullPath(p.S())); }
	static canonical_FsPath_ErrorCode(p, ec) {
		const e = ec;
		if (!Fs.exists_FsPath(p)) { e.v = 2; return new FsPath(); }
		e.v = 0;
		return Fs.canonical_FsPath(p);
	}
	static weakly_canonical_FsPath(p) { return FsPath.new_str(FsNet.fullPath(p.S())); }
	static weakly_canonical_FsPath_ErrorCode(p, ec) { (ec).v = 0; return Fs.weakly_canonical_FsPath(p); }

	/** $TMPDIR, or /tmp when it is not set. */
	static temp_directory_path() {
		const t = process.env['TMPDIR'];
		return FsPath.new_str(t != null ? t : '/tmp');
	}

	/** File.Move(a, b, true), which throws when it fails. */
	static rename_FsPath_FsPath(a, b) { FsNet.moveFile(a.S(), b.S()); }

	/** rename(a, b, ec): File.Move(a, b, true); FileNotFoundException gives ENOENT (2), anything else (a missing
	 *  destination directory included: DirectoryNotFoundException) EACCES (13). */
	static rename_FsPath_FsPath_ErrorCode(a, b, ec) {
		const e = ec;
		let fa, fb;
		try { fa = FsNet.fullPath(a.S()); fb = FsNet.fullPath(b.S()); }
		catch (x) { e.v = 13; return; }
		if (!FsNet.fsFileExists(fa)) { e.v = 2; return; }
		try { FsNet.moveFull(fa, fb); e.v = 0; }
		catch (x) {
			if (x != null && (x).code === 'ENOENT') e.v = FsNet.parentExists(fb) ? 2 : 13;
			else e.v = 13;
		}
	}

	/** The C# port's create_hard_link(target, link, ec): EEXIST (17) when link exists, otherwise a copy of target
	 *  at link (ENOENT when that fails). */
	static create_hard_link(target, link, ec) {
		const e = ec;
		if (FsNet.fileExists(link.S())) { e.v = 17; return; }
		try { FsNet.copyFile(target.S(), link.S()); e.v = 0; } catch (x) { e.v = 2; }
	}

	static equivalent_FsPath_FsPath(a, b) {
		return FsNet.fullPath(a.S()) === FsNet.fullPath(b.S());
	}
	static equivalent_FsPath_FsPath_ErrorCode(a, b, ec) {
		const e = ec;
		if (!Fs.exists_FsPath(a) || !Fs.exists_FsPath(b)) { e.v = 2; return false; }
		e.v = 0;
		return Fs.equivalent_FsPath_FsPath(a, b);
	}

	static status_FsPath(p) { return FileStatus.Of(p.S()); }
	static status_FsPath_ErrorCode(p, ec) { (ec).v = 0; return FileStatus.Of(p.S()); }
	static symlink_status_FsPath(p) { return FileStatus.Of(p.S()); }
	static symlink_status_FsPath_ErrorCode(p, ec) { (ec).v = 0; return FileStatus.Of(p.S()); }
}
// (ts/src/cpp/fs.ts without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)
