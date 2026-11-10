// compare_ast.mjs A.js B.js [...pairs] - parse each pair of JavaScript files with acorn (the parser Node's own tooling
// ships, /opt/node-tools/node_modules/acorn; ACORN overrides) and compare their syntax trees, ignoring positions,
// comments, the spelling of literals (raw) and parentheses. Prints "identical" or the first difference with its path
// and both files' text around it; exit status 1 on a difference. Used to show that js/gen/engine.js is what tsc makes
// of ts/gen/engine.ts (the TypeScript port's own build, ts/dist), and the runtime js/src/cpp the same of ts/src/cpp.
// Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see js/README.md.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const acorn = require(process.env.ACORN || '/opt/node-tools/node_modules/acorn');

const SKIP = new Set(['start', 'end', 'loc', 'range', 'raw']);
function parse(f) {
	const src = fs.readFileSync(f, 'utf8');
	return { src, ast: acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }) };
}
function same(a, b, path, out, na, nb) {
	if (a && typeof a === 'object' && typeof a.type === 'string' && a.start !== undefined) { na = a; nb = b; }
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
		if (typeof a === 'number' && typeof b === 'number' && Object.is(a, b)) return true;
		out.path = path; out.a = a; out.b = b; out.na = na; out.nb = nb; return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) { out.path = path; out.a = 'array?'; out.b = 'array?'; out.na = na; out.nb = nb; return false; }
	if (Array.isArray(a)) {
		if (a.length !== b.length) { out.path = path + '.length'; out.a = a.length; out.b = b.length; out.na = na; out.nb = nb; return false; }
		for (let i = 0; i < a.length; i++) if (!same(a[i], b[i], path + '[' + i + ']', out, na, nb)) return false;
		return true;
	}
	const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => !SKIP.has(k)));
	for (const k of keys) {
		if (k === 'value' && a.type === 'Literal' && a.regex) continue;   // compared through regex
		if (!same(a[k], b[k], path + '.' + k, out, na, nb)) return false;
	}
	return true;
}
let fail = 0;
const args = process.argv.slice(2);
for (let i = 0; i + 1 < args.length; i += 2) {
	let A, B;
	try { A = parse(args[i]); B = parse(args[i + 1]); }
	catch (e) { fail = 1; console.log(`PARSE ERROR: ${args[i]} or ${args[i + 1]}: ${e.message}`); continue; }
	const out = {};
	if (same(A.ast, B.ast, 'Program', out)) { console.log(`identical: ${args[i]}  ${args[i + 1]}  (${A.ast.body.length} top-level statements)`); continue; }
	fail = 1;
	console.log(`DIFFERENT: ${args[i]}  ${args[i + 1]}\n  at ${out.path}: ${JSON.stringify(out.a)?.slice(0, 120)} vs ${JSON.stringify(out.b)?.slice(0, 120)}`);
	const show = (s, n) => n && n.start !== undefined ? s.slice(n.start, Math.min(n.end, n.start + 400)).replace(/\n/g, '\n    ') : '?';
	console.log('  first:\n    ' + show(A.src, out.na).slice(0, 600) + '\n  second:\n    ' + show(B.src, out.nb).slice(0, 600));
}
process.exit(fail);
