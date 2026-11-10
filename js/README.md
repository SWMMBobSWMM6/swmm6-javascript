# The OpenSWMM 6 1D engine in JavaScript, byte for byte

A translation of the 1D engine of OpenSWMM 6 (HydroCouple/openswmm.engine, branch `swmm6_rel`, commit 88329d6) into
plain JavaScript (ES modules that Node runs as they are: no TypeScript, no build step, no dependency outside Node),
held to the same output as the C++ engine: the same binary `.out` file and the same `.rpt` report, apart from the
three clock lines. It is not SWMM6 and not a HydroCouple or EPA release; it is a translation checked against SWMM6.

## Result

**480 of 480 models byte-identical** against the C++ reference engine built from the same commit and run on one
thread (`OMP_NUM_THREADS=1`), on the 480-model gate set the SWMM5 ports were checked on, drawn from
1729-SWMM5-Models-2030. Gate runs `js6_a` (158 of 158), `js6_b` (161 of 161) and `js6_c` (161 of 161), the corpus in
three parts of about equal time (`gate/ids_corpus_a.txt`, `_b`, `_c`); 28.7, 20.9 and 20.0 minutes, a median of
1.33 s per model; the slowest, EPA/72_H&H_Elements(2).inp, took 674 s.

**452 of 452 extra decks byte-identical**: SWMM6's own tests (the input files in the upstream repository's `tests`
folder at 88329d6) and the synthetic decks of swmm6-rust's gate (the finite-volume solver, its structure coupling,
the newer hydrology and the input checks). Gate runs `js6_x_a` (450 of 450, 9.5 minutes, a median of 0.49 s per
deck), and `js6_x_b` and `js6_x_c`, one deck each: legacy_small.inp and refactored_small.inp, year-long dynamic-wave
runs with a five-second step that write 155 MB `.out` files and took the TypeScript port 1,704 and 1,613 s, close to
the gate's 1,800 s limit; here they took 1,282 and 1,238 s, each run alone on a quiet machine. No model or deck
timed out.

**The independent rerun: 480 of 480.** A clean copy of commit ed2c437 (`git archive`; no file of the engine, the
runtime, the math or the translators has changed since) where the translator was rebuilt and the engine regenerated
from `cs/gen` (byte-identical to the committed `gen/engine.js`, with the same manifest and an empty TODO list), the
runtime written again from `ts/src` with ts2js.mjs (byte-identical), the math translated again from glibc's sources,
compiled to GIMPLE afresh (`glibm.js`, `glibm2.js` and their runtimes byte-identical) and the check programs written
again (byte-identical), every file then syntax-checked by Node (`gate/js6_v_build.txt`), and gated from that copy:
runs `js6_v_a` (158 of 158), `js6_v_b` (161 of 161) and `js6_v_c` (161 of 161); 22.0, 22.5 and 22.1 minutes under
the lock, a median of 1.15 s per model. Every model's `.out` and `.rpt` hashes and exit code are the same as in the
first run (`js6_a` to `js6_c`). `js6_v_a` and `js6_v_c` ran in two and three sittings: `gate/batches.py` stops a
sitting before its two hours (queue included) are up, and the next continues with `--resume`, which runs no model
twice (`gate/js6_v_a_times.txt`, `js6_v_c_times.txt`; the times above are the sittings' sums).

**The main session's check: 48 of 48 and 12 of 12.** A clean `git clone` of commit 296062e (in memory), where the
translator was rebuilt and the engine, the runtime, the math (glibc 2.39's source compiled to GIMPLE again; nothing of
glibc run) and the check programs were written again (no file changed: `git status` empty; `node --check` passes on
all 33 JavaScript files), then gated: run `js6_main` on 45 corpus models drawn at random (`random.Random(20261110)`)
plus `Hydrology/save_rtk_long.inp`, `one_sub_one_rdii_node.inp` and `Use_SeasonalRDIIn.inp`, the decks that SAVE and
USE `cho.txt` (48 of 48; 167 s), and run `js6_main_x` on 12 extra decks drawn the same way (12 of 12; 7 s); the same
samples as the Kotlin and Groovy ports' checks. Ids in `gate/ids_main_check.txt` and `gate/ids_main_check_extra.txt`.

`Hydrology/cho.txt`, which two corpus decks SAVE and a third USEs, was 1,114,474 bytes, md5
5b0ca1fe78588202fa779dbfa417b089, after the last run.

Every result, with the SHA-256 of each `.out` and `.rpt`, is in `results/NAME.json`, with the run's log beside it
(`results/NAME_run.txt`) and the queue, start and end times in `gate/NAME_times.txt`.

A model passes when its `.out` is byte-identical to the reference's (when the reference writes one), its `.rpt` is
identical after removing the lines "Analysis begun", "Analysis ended" and "Total elapsed time", and its exit code is
the same. The gate runs every model through `runswmm6_saves.sh`, which backs up the files a deck SAVEs and restores
them afterwards, so that no deck changes a file another deck reads.

## How it was made

The C++ engine was translated to C# first (`cs/gen`, 480 of 480), and this engine is translated from that C#, not from
the C++, by a translator written for it: `tools/cs2x/Cs2Js.cs`, `JsTypes.cs` and `JsFn.cs`, which read the C# through
Roslyn's semantic model and print JavaScript (`js/gen/engine.js`, one ES module, 178,665 lines, 773 classes; 0
untranslated constructs, `cs2js_todo.txt`). It is a copy of the TypeScript translator (`Cs2Ts.cs`, `TsTypes.cs`,
`TsFn.cs`) that writes no types: JavaScript is TypeScript's run-time language, so every expression and statement the
TypeScript translator writes, with its exact 32- and 64-bit integer arithmetic (`| 0`, `Math.imul`, `>>> 0`, and
`cpp.L`'s number-or-BigInt longs), is kept, and only declarations and casts change (`tools/cs2x/JS.md` lists each).

The runtime (`src/cpp`, 16 files, and `src/main.js`, the command line: 7,902 lines with `libm/nan.js`) is the small
part of the C++ standard library and of glibc that the engine calls. It is the TypeScript port's runtime
(`ts/src/cpp`, `ts/src/main.ts`) with the types removed by `tools/ts2js.mjs`, a script written for this port
(`make_runtime.sh`): it tokenizes the TypeScript and cuts out type annotations, type parameters and arguments, `as`
casts, the non-null `!`, type-only declarations and imports, and the modifiers `private`, `readonly` and the like,
and changes nothing else; every line keeps its number, and a note at the end of each file names its source. It was
not made with tsc, and nothing in `js/` loads anything from `ts/`. No file of the runtime is edited by hand.

The 19 glibc math functions the engine calls (exp, log, pow, sin, cos, tan, asin, acos, atan, log10, atan2, log2,
sinh, tanh, expm1, log1p, cosh, cbrt, hypot) are `src/cpp/libm/glibm.js` and `glibm2.js` (7,738 lines), written by a
new JavaScript back end of `tools/libm/gim2x.py` from GCC's compiled form of glibc 2.39's own code (`make_glibm.sh`),
with glibc's FMA variants where x86-64 glibc picks them; JavaScript's `Math` is not used for any of them (the
engine calls it only for operations that are exact in every correct implementation: sqrt, abs, floor, ceil, trunc,
fround and imul). The back end writes each routine by the TypeScript back end's
rules and removes the types from the signature and the declarations, the only places that back end writes them; its
hand-written wrappers (pow's fast path and the SVID wrappers) are the TypeScript ones without types. The math
runtimes `glibm_rt.js` and `glibm2_rt.js` (exact fma, bit casts, frexp, ldexp, ...) are `tools/libm`'s TypeScript
ones without types (ts2js.mjs), kept in `tools/libm` beside them. The Go, Java, TypeScript, Kotlin and Groovy files
gim2x.py writes are unchanged (`results/gim2x_unchanged.txt`).

## How it was checked

- **Against the TypeScript port's compiled program**: `test/compare_ast.mjs` parses `gen/engine.js` and every runtime
  and math file, and the JavaScript tsc wrote from the TypeScript sources for the TypeScript port (`ts/dist`), with
  acorn, and compares the syntax trees (positions, comments, parentheses and the spelling of literals aside):
  **identical**, for the engine (1,257 top-level statements) and for all 22 runtime, math and command-line files.
  So this port runs, statement for statement, the program the TypeScript port runs; tsc wrote nothing here, it only
  made the comparison possible. The comparison found three bugs in the first version of ts2js.mjs, one of which Node
  itself accepted (`../lessons/40-type-arguments-left-in-are-comparisons.md`).
- **The math**: `test/run_libm_tests.sh` compares each of the 19 functions (and fma, frexp, ldexp) with the system's
  glibc 2.39, bit for bit, by the method of `tools/libm/test` and with its programs (`test/libm`, the TypeScript ones
  without types): a million arguments per function over the ranges SWMM uses with special values, and 100,000 edge
  cases each, for the first ten; a million per function over wide ranges and every branch threshold, with signed
  zeros, infinities, subnormals and NaNs of both signs with several payloads, for the other nine; each under V8's
  optimizing compiler and again with `--jitless`; and 20 million arguments of pow's fast path against the full
  translation: **0 differences** in all 64 runs of a function over its vectors (32 compiled, 32 interpreted; 0
  NaN-sign and 0 NaN-payload differences) and 0 of the 20,000,000 pow arguments (`results/libm_tests.txt`).
- **The runtime**: `test/run_runtime_checks.sh` runs the TypeScript port's checks (`tests/`, without their types:
  `test/rt`, made by `test/make_checks.sh`) against this runtime and compares with glibc and libstdc++: libm (27
  functions, 300,576 cases each), printf (179,756 cases), sscanf (1,728), from_chars, strtol, strtod, ctime and the
  rest (752 cases and 137 unit checks), introsort's permutations (6,447 cases), the hash tables' node order and
  std::hash, the other containers and the prime table, the streams and the file system: **identical**, apart from one
  printf case where the C# runtime and glibc differ (`%#.2g` of 99.995; this runtime agrees with glibc)
  (`results/runtime_checks.txt`).
- **The engine**: the gate (above), run on the corpus and on the extra decks.

## Build and run

Needs Node 22 (tested with v22.23.4; Node 18 or newer should do). There is nothing to build or install. Run a model
the way the C++ command line runs it:

    js/runswmm6 model.inp model.rpt model.out

(`runswmm6` gives Node a 4 GB heap and a 512 MB stack; `node js/src/main.js ...` works too for small models.)

To regenerate: `tools/cs2x/build_js.sh && dotnet tools/cs2x/bin/cs2js.dll cs js/gen` (the engine, from `cs/gen`;
needs the .NET 8 SDK, about a minute), `js/make_runtime.sh` (the runtime, from `ts/src`), `js/make_glibm.sh
GLIBM_BUILD` (the math, from the GIMPLE dumps and tables that `tools/libm/build_glibm.sh` and `extract_tables.py`
write), `js/test/make_checks.sh` (the check programs).

The gate: `js/gate/run_chunk.sh NAME corpus|extra [IDS_FILE] [ENGINE] [--resume]` runs `gate/gate.py` on this port
with the SAVE-file wrapper inside the shared corpus lock, as a series of `--resume` calls that stops before its two
hours are up (`gate/batches.py`); `js/gate/rerun_build.sh` makes the clean copy of a commit that the independent rerun
gates.

## What this does not show

- Agreement on models outside the 480 and the 452. A feature no gate model or deck uses is untested.
- The reference's parallel runs: every parallel loop runs on one thread, in order, as the C++ engine does when it
  is held to one thread.
- The 2D and other modules of OpenSWMM 6 beyond the 1D engine the command line runs.
- Every input to the 19 math functions: about a million arguments each is a test, not a proof.
- Other JavaScript engines. Only Node 22's V8 was used; the exactness rests on IEEE double arithmetic, BigInt and
  typed arrays, which every engine has, but no other was tried.
- Speed. The times above were measured on a shared two-core machine while other agents' runs came and went, and no
  interleaved benchmark against the TypeScript port or the C++ engine was run, so no speed ratio is claimed. The
  engine is the TypeScript port's program, so it should run at that port's speed; about a quarter of the time of the
  slowest decks goes to pow and its software fused multiply-add (a V8 profile of the first 100 seconds of
  legacy_small.inp: 18% of the ticks in `glibm_rt.js`'s fma, 5% in pow itself), the price of reproducing glibc's
  FMA routines without a hardware fma.

## License and attribution

The engine is a translation of the OpenSWMM Engine, Copyright 2026 HydroCouple Developers, licensed under the
Apache License, Version 2.0 (https://github.com/HydroCouple/openswmm.engine, branch `swmm6_rel`, commit 88329d6).
Portions derive from the USEPA Storm Water Management Model, which is in the public domain; the USEPA does not
endorse this translation, and neither does HydroCouple. The math routines `src/cpp/libm/glibm.js` and `glibm2.js`, and
their runtimes `glibm_rt.js` and `glibm2_rt.js`, are translations of glibc 2.39 code and remain under glibc's licence,
the GNU Lesser General Public License 2.1 or later.

## AI use

The translator (`tools/cs2x/Cs2Js.cs`, `JsTypes.cs`, `JsFn.cs`, a copy of the TypeScript translator changed), the type
remover `tools/ts2js.mjs` (and so the runtime, which is the TypeScript port's runtime, also Claude's, without its
types), the JavaScript back end of gim2x.py, the port's scripts and checks, and these notes were written by Claude,
Anthropic's AI model, for Robert Dickinson, who directed the work. The engine is a mechanical translation of OpenSWMM 6
(Apache-2.0, HydroCouple Developers), itself derived in part from the public-domain EPA SWMM; it was checked by running
it against the C++ engine, not by reading it. The glibc-derived math is LGPL-2.1-or-later. See `../AI-USE.md`.
