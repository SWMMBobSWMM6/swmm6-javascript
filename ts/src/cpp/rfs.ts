// rfs.ts - the C library functions of cs/runtime/Fs.cs (the part of the C# partial class Cpp.R in that file):
// errno, stderr and stdin, getenv, ctype in the C locale, atol / strtol0, ferror (set only by a directory's failed
// read), fileno / setvbuf (no-ops as in the C# port), rename, fgetc, time(object), strncpy, strncmp, memcmp, sprintf
// and the char-array helpers of the C# back end, plus File_Exists (System.IO.File.Exists exactly: fsnet.ts). Part C's R (CRuntime.ts) forwards its members of
// these names to RFs, so the engine's cpp.R.getenv, cpp.R.stderr_, ... reach them (R could also extend RFs: a
// member R declares itself would shadow the one here). Nothing here runs at module load but the class definition;
// stderr_ and stdin_ are made on first use (accessors) over part C's CFile and CFileStream (Console.OpenStandardError
// and OpenStandardInput: written through at once, read from the descriptor).
// Runtime part D (cs/runtime/Fs.cs).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

import * as cpp from './index.js';
import { FsNet } from './fsnet.js';

let errnoV = 0;
let stderrF: any = null;
let stdinF: any = null;

function i32(x: cpp.L): number { return typeof x === 'bigint' ? Number(BigInt.asIntN(32, x)) : x | 0; }

export class RFs {
	protected constructor() { }

	static get errno_(): number { return errnoV; }
	static set errno_(v: number) { errnoV = v; }

	/** new CFile(Console.OpenStandardError(), true): made on first use. */
	static get stderr_(): any {
		if (stderrF == null) stderrF = new cpp.CFile(cpp.CFileStream.stdOut(2), true);
		return stderrF;
	}
	static set stderr_(f: any) { stderrF = f; }

	/** new CFile(Console.OpenStandardInput(), true): made on first use. */
	static get stdin_(): any {
		if (stdinF == null) stdinF = new cpp.CFile(cpp.CFileStream.stdIn(0), true);
		return stdinF;
	}
	static set stdin_(f: any) { stdinF = f; }

	/** System.IO.File.Exists (the engine's calls of it). */
	static File_Exists(path: string): boolean { return FsNet.fileExists(path); }

	/** Environment.GetEnvironmentVariable: a fresh copy of the value, or a null pointer. */
	static getenv(name: cpp.CPtr): cpp.CPtr {
		const v = process.env[FsNet.cstr(name)];
		return v == null ? cpp.CPtr.ZERO : cpp.R.Lit(v);
	}

	// ctype in the C locale
	static isdigit(c: number): number { return (c >= 48 && c <= 57) ? 1 : 0; }
	static isalpha(c: number): number { return ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) ? 1 : 0; }
	static isalnum(c: number): number { return (RFs.isdigit(c) !== 0 || RFs.isalpha(c) !== 0) ? 1 : 0; }
	static isspace(c: number): number { return (c === 32 || (c >= 9 && c <= 13)) ? 1 : 0; }
	static isupper(c: number): number { return (c >= 65 && c <= 90) ? 1 : 0; }
	static islower(c: number): number { return (c >= 97 && c <= 122) ? 1 : 0; }
	static ispunct(c: number): number { return (c > 32 && c < 127 && RFs.isalnum(c) === 0) ? 1 : 0; }
	static isprint(c: number): number { return (c >= 32 && c < 127) ? 1 : 0; }
	static isxdigit(c: number): number { return (RFs.isdigit(c) !== 0 || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)) ? 1 : 0; }
	static tolower(c: number): number { return (c >= 65 && c <= 90) ? c + 32 : c; }

	static atol(s: cpp.CPtr): cpp.L { return cpp.R.strtol(s, new cpp.Cell<cpp.CPtr>(s), 10); }
	static strtol0(s: cpp.CPtr, b: number = 10): cpp.L { return cpp.R.strtol(s, new cpp.Cell<cpp.CPtr>(s), b); }
	/** The error indicator: set only by a read of a directory that fopen opened (CFile.Err, ReadFailed). */
	static ferror(f: cpp.CFile): number { return f != null && f.Err ? 1 : 0; }
	static fileno(f: cpp.CFile): number { return 3; }
	static setvbuf(f: cpp.CFile, b: cpp.CPtr, mode: number, size: cpp.L): number { return 0; }

	/** File.Move(a, b, overwrite: true): 0, or -1 when it fails. */
	static rename(a: cpp.CPtr, b: cpp.CPtr): number {
		try { FsNet.moveFile(FsNet.cstr(a), FsNet.cstr(b)); return 0; } catch (e) { return -1; }
	}

	static fgetc(f: cpp.CFile): number { const c = f.S.ReadByte(); if (c < 0) f.ReadFailed(); return c; }

	/** time(p) for a pointer argument the engine passes as an object (C#'s time(object?)); p is not written. */
	static time_o(p: any): cpp.L { return Math.floor(Date.now() / 1000); }

	static strncpy(d: cpp.CPtr, s: cpp.CPtr, n: cpp.L): cpp.CPtr {
		const D: any = d, S: any = s;
		const m = i32(n);
		let i = 0;
		for (; i < m && S.B[S.O + i] !== 0; i++) D.B[D.O + i] = S.B[S.O + i] & 0xFF;
		for (; i < m; i++) D.B[D.O + i] = 0;
		return d;
	}

	static strncmp(a: cpp.CPtr, b: cpp.CPtr, n: cpp.L): number {
		const A: any = a, B: any = b;
		const m = i32(n);
		for (let i = 0; i < m; i++) {
			const x = A.B[A.O + i] & 0xFF, y = B.B[B.O + i] & 0xFF;
			if (x !== y) return x - y;
			if (x === 0) return 0;
		}
		return 0;
	}

	static memcmp(a: cpp.CPtr, b: cpp.CPtr, n: cpp.L): number {
		const A: any = a, B: any = b;
		const m = i32(n);
		for (let i = 0; i < m; i++) { const x = A.B[A.O + i] & 0xFF, y = B.B[B.O + i] & 0xFF; if (x !== y) return x - y; }
		return 0;
	}

	/** char buf[n] = { ... }: n bytes (at least one), the given ones first, the rest zero. */
	static BufOf(n: number, vals: number[]): cpp.CPtr {
		const p: any = cpp.R.Buf_i(n);
		const b = p.B, m = Math.min(vals.length, b.length - p.O);
		for (let i = 0; i < m; i++) b[p.O + i] = vals[i] & 0xFF;
		return p;
	}

	/** Copy-assigning a char array member: all its bytes. */
	static memcpyBuf(d: cpp.CPtr, s: cpp.CPtr): void {
		const D: any = d, S: any = s;
		FsNet.copy(S.B, S.O, D.B, D.O, Math.min(D.B.length - D.O, S.B.length - S.O));
	}

	static sprintf(buf: cpp.CPtr, fmt: cpp.CPtr, ...args: any[]): number {
		const b: ArrayLike<number> = cpp.R.Format(fmt, args);
		const B: any = buf;
		FsNet.copy(b, 0, B.B, B.O, b.length);
		B.B[B.O + b.length] = 0;
		return b.length;
	}
}
