# C# to JavaScript: how tools/cs2x/Cs2Js.cs maps the generated engine

The JavaScript engine (`js/gen/engine.js`) is written from the verified C# engine (`cs/gen`, 480 of 480 and 452 of 452
against the SWMM6 reference) by `tools/cs2x/Cs2Js.cs`, `JsTypes.cs` and `JsFn.cs`, a copy of the TypeScript translator
(`Cs2Ts.cs`, `TsTypes.cs`, `TsFn.cs`; mapping in TS.md) that writes no types. JavaScript is TypeScript's run-time
language: every expression and statement the TypeScript translator writes is already JavaScript, and its numbers,
names, references, element makers, exceptions, gotos and switches (TS.md) carry over unchanged. Only declarations and
casts differ, and this file lists every difference.

    tools/cs2x/build_js.sh && dotnet tools/cs2x/bin/cs2js.dll cs js/gen

writes `js/gen/engine.js`, `js/cs2js_runtime.txt` (the runtime members used and their JavaScript names) and
`js/cs2js_notes.txt`, and `js/cs2js_todo.txt` (untranslated constructs: none).

## What the TypeScript translator writes, and what this one writes instead

| construct | TypeScript (TsFn.cs, TsTypes.cs) | JavaScript (JsFn.cs, JsTypes.cs) |
|---|---|---|
| parameter, local, field, catch variable | `x: T` | `x` |
| method | `m(a: T): R { ... }` | `m(a) { ... }` |
| abstract method | `abstract m(a: T): R;` | nothing (C# makes no object of an abstract class, and every concrete class overrides it) |
| abstract class | `export abstract class X` | `export class X` |
| class extending a runtime class | `extends cpp.Vec<number>` | `extends cpp.Vec` |
| constant | `static readonly K: T = v;` | `static K = v;` |
| several constructors | `constructor(...$a: any[])`, `let x: any;`, `let $s: any[] = [];` | `constructor(...$a)`, `let x;`, `let $s = [];` |
| delegate type | `export type FN3 = (a0: number) => void;` | nothing (a delegate is a function value) |
| temporaries | `let $t1: any, $t2: any;` | `let $t1, $t2;` |
| address-taken local | `new cpp.Cell<number>(v)` | `new cpp.Cell(v)` |
| lambda | `((a: T): R => { ... })` | `((a) => { ... })` |
| element maker | `((): T => new X())` | `(() => new X())` |
| method group as a delegate | `(($a0: T) => o.m($a0))`, `(($o: any) => ...)(recv)` | `(($a0) => o.m($a0))`, `(($o) => ...)(recv)` |
| new array | `new Array<T>(n).fill(d)` | `new Array(n).fill(d)` |
| new runtime object | `new cpp.Map<K, V>(...)` | `new cpp.Map(...)` |
| downcast, unboxing | `(x as T)` | `x` (parenthesized where it must be): a TypeScript cast checks nothing at run time |

Everything else is the same text. In particular the names: the translator keeps TypeScript's reserved words (`type`,
`number`, `readonly`, ...) in its list of names a local may not take, although JavaScript allows them, so that every
name in engine.js is the name in engine.ts.

## The check

`js/test/compare_ast.mjs` parses `js/gen/engine.js` and `ts/dist/gen/engine.js` (what tsc, the TypeScript compiler,
wrote from `ts/gen/engine.ts` for the TypeScript port) with acorn and compares the two syntax trees, ignoring positions,
comments and the spelling of literals: they are identical (all 1,257 top-level statements). So the JavaScript engine is,
statement for statement, the program the TypeScript port runs; tsc only made the comparison possible and wrote nothing
in js/.

## The runtime

The runtime (`js/src/cpp`) is the TypeScript runtime (`ts/src/cpp`) without its types: `js/tools/ts2js.mjs` removes
the type annotations, type-only declarations, casts and modifiers of the erasable TypeScript the runtime is written in
and changes nothing else (`js/make_runtime.sh`). The math (`js/src/cpp/libm/glibm.js`, `glibm2.js`) is written by the
JavaScript back end of `tools/libm/gim2x.py` (`js/make_glibm.sh`). ts/RUNTIME_HELPERS.md is the contract between the
engine and the runtime for JavaScript as for TypeScript.

Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see AI-USE.md and js/README.md.
