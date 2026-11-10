// main.js - the SWMM6 command line (src/cli/main.cpp), a hand port of cs/runtime/Program.cs: the same calls into
// the engine's C API (F__global in ts/gen/engine.ts) in the same order, the same messages on stdout (written to
// R.stdout_ as the C# writes them) and the same exit code; R.FlushAll before exit, as returning from main calls
// exit(), which flushes every open FILE. An exception that escapes the engine ends the process as .NET's
// unhandled-exception handler does: "Unhandled exception. ..." on stderr, no flushing of the C files, and exit code
// 134 (SIGABRT's). ts/runswmm6 runs this with a large heap and stack.
// Usage: node dist/src/main.js <input.inp> <report.rpt> [output.out]
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

import * as fs from 'node:fs';
import * as cpp from './cpp/index.js';
import { F__global as API } from '../gen/engine.js';

const VERSION = '6.0.0-alpha.4';

/** Encoding.Latin1.GetBytes: a byte per character, '?' for one above U+00FF. */
function latin1(s) {
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i] = c < 256 ? c : 63; }
	return b;
}

function Out(s) { const b = latin1(s); cpp.R.stdout_.S.Write(b, 0, b.length); }

/** R.Str: the C string's bytes as a C# string (Latin-1). */
function Str(p) {
	const q = p;
	let s = '';
	for (let i = q.O; q.B[i] !== 0; i++) s += String.fromCharCode(q.B[i] & 0xFF);
	return s;
}

/** {1:F2} of .NET Core: the exact value rounded to two places, half away from zero (toFixed rounds the exact
 *  value half up, the same for a non-negative number). */
function F2(x) { return x.toFixed(2); }

function Run(argv) {
	if (argv.length < 1) { Out('\nError: not enough arguments. Use --help for usage.\n\n'); return 1; }
	if (argv[0] === '--version' || argv[0] === '-v') { Out('openswmm.engine ' + VERSION + '\n'); return 0; }
	if (argv.length < 2) {
		Out('\nError: need at least input and report file paths.\n');
		Out('Usage: openswmm <input.inp> <report.rpt> [output.out]\n\n');
		return 1;
	}
	const inp = argv[0], rpt = argv[1], outf = argv.length > 2 ? argv[2] : '';
	Out('\n... OpenSWMM Engine ' + VERSION + '\n... Input: ' + inp + '\n... Report: ' + rpt + '\n... Output: ' + outf + '\n');
	cpp.R.fflush(cpp.R.stdout_);
	const t0 = process.hrtime.bigint();
	const engine = API.swmm_engine_create();
	if (engine == null) { Out('Error: failed to create engine instance.\n'); return 1; }
	let err = API.swmm_engine_open(engine, cpp.R.Lit(inp), cpp.R.Lit(rpt), cpp.R.Lit(outf), cpp.CPtr.ZERO);
	if (err !== 0) {
		Out('Error opening input file: ' + Str(API.swmm_get_last_error_msg(engine)) + '\n');
		API.swmm_engine_destroy(engine);
		return err;
	}
	err = API.swmm_engine_initialize(engine);
	if (err !== 0) {
		Out('Error initializing: ' + Str(API.swmm_get_last_error_msg(engine)) + '\n');
		API.swmm_engine_close(engine);
		API.swmm_engine_destroy(engine);
		return err;
	}
	const save = outf.length > 0 ? 1 : 0;
	err = API.swmm_engine_start(engine, save);
	if (err !== 0) {
		Out('Error starting simulation: ' + Str(API.swmm_get_last_error_msg(engine)) + '\n');
		API.swmm_engine_close(engine);
		API.swmm_engine_destroy(engine);
		return err;
	}
	const elapsed = [0];
	const elapsedPtr = cpp.Ptr.new_TA_l(elapsed, 0);
	let steps = 0;
	for (;;) {
		err = API.swmm_engine_step(engine, elapsedPtr);
		if (err !== 0) { Out('\nError at step ' + steps + ': ' + Str(API.swmm_get_last_error_msg(engine)) + '\n'); break; }
		if (elapsed[0] <= 0.0) break;
		steps++;
	}
	Out('\n... ' + steps + ' steps completed.\n');
	let result = err;
	const Fin = (status, phase) => {
		if (status !== 0) {
			Out('Error ' + phase + ': ' + Str(API.swmm_get_last_error_msg(engine)) + '\n');
			if (result === 0) result = status;
		}
	};
	Fin(API.swmm_engine_end(engine), 'ending simulation');
	Fin(API.swmm_engine_report(engine), 'writing report');
	Fin(API.swmm_engine_close(engine), 'closing simulation');
	API.swmm_engine_destroy(engine);
	const secs = Number(process.hrtime.bigint() - t0) / 1e9;
	Out('... OpenSWMM Engine ' + (result === 0 ? 'completed' : 'failed') + ' in ' + F2(secs) + ' seconds.\n\n');
	return result;
}

function main() {
	let rc;
	try {
		rc = Run(process.argv.slice(2));
	} catch (e) {
		// .NET's unhandled-exception handler: the message on stderr, no exit() (the C files are not flushed), SIGABRT
		const what = e instanceof Error ? (e.stack || String(e)) : String(e);
		try { fs.writeSync(2, 'Unhandled exception. ' + what + '\n'); } catch (x) { /* nothing more to do */ }
		process.exit(134);
	}
	cpp.R.FlushAll();          // returning from main calls exit(), which flushes every open FILE
	process.exit(rc);
}

main();
// (ts/src/main.ts without its TypeScript types, written by js/tools/ts2js.mjs; see js/README.md.)
