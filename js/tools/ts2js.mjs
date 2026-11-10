// ts2js.mjs - remove the TypeScript types from a TypeScript source file and write the JavaScript that is left.
//
//   node js/tools/ts2js.mjs IN.ts OUT.js [IN2.ts OUT2.js ...]
//
// Written for the SWMM6 JavaScript port, whose runtime (js/src/cpp) is the TypeScript port's runtime (ts/src/cpp)
// with its types removed, and whose checks (js/test) are the TypeScript port's checks the same way. It is not a
// general TypeScript compiler: it handles the "erasable" TypeScript those files are written in (no enums,
// namespaces or parameter properties; RUNTIME_PORTING.md) and nothing else, and it changes nothing but types:
//
//   - type annotations of parameters, variables, fields, catch variables and return types (`x: T`, `): T`), with the
//     optional and definite marks (`x?: T`, `x!: T`); type parameters (`<T>`) and type arguments of calls and of
//     `new` and `extends` (`f<T>(...)`); `as T` casts and the non-null `!`;
//   - declarations that are only types: `type X = ...;`, `interface X { ... }`, `import type ...;`, index signatures;
//     `implements ...`; the modifiers `public`, `private`, `protected`, `readonly`, `abstract`, `override`, `declare`;
//   - an import none of whose names is used as a value any more (tsc drops those too).
//
// Every other character is copied as it is, and every line keeps its number: a type that spans lines leaves its line
// breaks behind. The first line's file name (`// name.ts - ...`) becomes name.js. The output is checked, not trusted:
// js/test/compare_ast.mjs compares each file's syntax tree with the JavaScript tsc wrote for the TypeScript port
// (ts/dist), and the runtime checks and the gate run it.
// Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see js/README.md.
import fs from 'node:fs';
import path from 'node:path';

// ------------------------------------------------------------------------------------------------ tokens
// (every > is a token of its own, so that `>>` can close two type argument lists; the text written is the same)
const PUNCT = ['...', '===', '!==', '**=', '<<=', '&&=', '||=', '??=', '=>', '==', '!=', '<=',
	'&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '**'];
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw',
	'instanceof', 'yield', 'await']);

function tokenize(src) {
	const T = [];
	let i = 0;
	const n = src.length;
	const tpl = [];            // open template expressions: the brace depth inside each
	let lastSig = null;
	const push = (t, s) => { const tok = { t, s }; T.push(tok); if (t !== 'ws' && t !== 'com') lastSig = tok; };
	const scanTpl = (start) => {   // from just after ` or }: to the closing ` or to ${
		let j = start;
		for (;;) {
			if (j >= n) throw new Error('unterminated template');
			const c = src[j];
			if (c === '\\') { j += 2; continue; }
			if (c === '`') return [j + 1, false];
			if (c === '$' && src[j + 1] === '{') return [j + 2, true];
			j++;
		}
	};
	while (i < n) {
		const c = src[i];
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			let j = i; while (j < n && ' \t\n\r'.includes(src[j])) j++;
			push('ws', src.slice(i, j)); i = j; continue;
		}
		if (c === '/' && src[i + 1] === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; push('com', src.slice(i, j)); i = j; continue; }
		if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2) + 2; push('com', src.slice(i, j)); i = j; continue; }
		if (c === '"' || c === "'") {
			let j = i + 1; while (src[j] !== c) { if (src[j] === '\\') j++; j++; }
			push('str', src.slice(i, j + 1)); i = j + 1; continue;
		}
		if (c === '`') { const [j, open] = scanTpl(i + 1); push(open ? 'tplh' : 'str', src.slice(i, j)); if (open) tpl.push(0); i = j; continue; }
		if (c === '}' && tpl.length > 0 && tpl[tpl.length - 1] === 0) {
			const [j, open] = scanTpl(i + 1); push(open ? 'tplm' : 'tplt', src.slice(i, j)); if (!open) tpl.pop(); i = j; continue;
		}
		if (/[A-Za-z_$]/.test(c)) { let j = i + 1; while (j < n && /[\w$]/.test(src[j])) j++; push('id', src.slice(i, j)); i = j; continue; }
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
			const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)([eE][+-]?\d+)?)n?/.exec(src.slice(i, i + 64));
			push('num', m[0]); i += m[0].length; continue;
		}
		if (c === '/') {
			const p = lastSig;
			const re = p === null || (p.t === 'p' && !(p.s === ')' || p.s === ']' || p.s === '}')) || (p.t === 'id' && REGEX_AFTER.has(p.s));
			if (re) {
				let j = i + 1, cls = false;
				while (cls || src[j] !== '/') { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
				j++; while (j < n && /[a-z]/.test(src[j])) j++;
				push('re', src.slice(i, j)); i = j; continue;
			}
		}
		if (c === '{' && tpl.length > 0) tpl[tpl.length - 1]++;
		if (c === '}' && tpl.length > 0) tpl[tpl.length - 1]--;
		let op = c;
		for (const p of PUNCT) if (src.startsWith(p, i)) { op = p; break; }
		push('p', op); i += op.length;
	}
	return T;
}

// ------------------------------------------------------------------------------------------------ the eraser
const MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare']);
const KEYWORDS = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
	'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return',
	'super', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await',
	'of', 'async']);

class Eraser {
	constructor(src) {
		this.T = tokenize(src);
		this.S = [];                      // indices of the significant tokens
		this.T.forEach((t, k) => { if (t.t !== 'ws' && t.t !== 'com') this.S.push(k); });
		this.drop = new Uint8Array(this.T.length);
	}
	tok(i) { return i < this.S.length ? this.T[this.S[i]] : { t: 'eof', s: '' }; }
	s(i) { return this.tok(i).s; }
	isId(i) { return this.tok(i).t === 'id'; }
	/** Drop significant tokens a..b-1 and the whitespace between them; with lead, the whitespace before a as well. */
	cut(a, b, lead = false) {
		if (b <= a) return;
		const from = lead && a > 0 ? this.S[a - 1] + 1 : this.S[a];
		const to = this.S[b - 1];
		for (let k = from; k <= to; k++) this.drop[k] = 1;
	}
	/** Drop a modifier keyword and the whitespace after it. */
	cutWord(i) { for (let k = this.S[i]; k < this.S[i + 1]; k++) this.drop[k] = 1; }
	out() {
		let o = '';
		for (let k = 0; k < this.T.length; k++) {
			const s = this.T[k].s;
			if (!this.drop[k]) o += s;
			else { const nl = s.split('\n').length - 1; if (nl > 0) o += '\n'.repeat(nl); }
		}
		return o;
	}
	/** The index just past the bracket that closes the one at i ((, [, { or a template head). */
	match(i) {
		let d = 0;
		for (let j = i; j < this.S.length; j++) {
			const t = this.tok(j);
			if (t.t === 'tplh') d++;
			else if (t.t === 'tplt') { d--; if (d === 0) return j + 1; }
			else if (t.t === 'p') {
				if (t.s === '(' || t.s === '[' || t.s === '{') d++;
				else if (t.s === ')' || t.s === ']' || t.s === '}') { d--; if (d === 0) return j + 1; }
			}
		}
		throw new Error('unbalanced bracket at token ' + i);
	}
	/** The index just past the > that closes the < at i, or -1 (type argument lists only: no operators inside). */
	matchAngle(i) {
		let d = 0;
		for (let j = i; j < this.S.length;) {
			const t = this.tok(j);
			if (t.t === 'p' && t.s === '<') { d++; j++; continue; }
			if (t.t === 'p' && t.s === '>') { d--; j++; if (d === 0) return j; continue; }
			if (t.t === 'p' && (t.s === '(' || t.s === '[' || t.s === '{')) { j = this.match(j); continue; }
			if (t.t === 'p' && !['.', ',', '|', '&', '?', ':', '=>', '=', '-'].includes(t.s)) return -1;
			if (t.t === 'eof') return -1;
			j++;
		}
		return -1;
	}

	// ---- types: each returns the index just past the type starting at i, or -1
	type(i) {
		let j = this.union(i);
		if (j < 0) return -1;
		if (this.s(j) === 'extends' && this.tok(j).t === 'id') {    // a conditional type
			const a = this.union(j + 1); if (a < 0 || this.s(a) !== '?') return j;
			const b = this.type(a + 1); if (b < 0 || this.s(b) !== ':') return -1;
			return this.type(b + 1);
		}
		return j;
	}
	union(i) {
		if (this.s(i) === '|') i++;
		let j = this.inter(i);
		while (j >= 0 && this.s(j) === '|') j = this.inter(j + 1);
		return j;
	}
	inter(i) {
		if (this.s(i) === '&') i++;
		let j = this.postfix(i);
		while (j >= 0 && this.s(j) === '&') j = this.postfix(j + 1);
		return j;
	}
	postfix(i) {
		let j = this.primary(i);
		while (j >= 0 && this.s(j) === '[') j = this.s(j + 1) === ']' ? j + 2 : this.match(j);
		return j;
	}
	primary(i) {
		const t = this.tok(i);
		if (t.t === 'p') {
			if (t.s === '(') { const j = this.match(i); return this.s(j) === '=>' ? this.type(j + 1) : j; }
			if (t.s === '{' || t.s === '[') return this.match(i);
			if (t.s === '-' && this.tok(i + 1).t === 'num') return i + 2;
			return -1;
		}
		if (t.t === 'str' || t.t === 'num') return i + 1;
		if (t.t !== 'id') return -1;
		if (t.s === 'new' && this.s(i + 1) === '(') { const j = this.match(i + 1); return this.s(j) === '=>' ? this.type(j + 1) : -1; }
		if (t.s === 'keyof' || t.s === 'readonly' || t.s === 'unique') return this.postfix(i + 1);
		if (t.s === 'typeof') i++;
		let j = i + 1;
		while (this.s(j) === '.' && this.isId(j + 1)) j += 2;
		if (this.s(j) === '<') { j = this.matchAngle(j); if (j < 0) return -1; }
		if (this.s(j) === 'is' && this.isId(j)) return this.type(j + 1);     // a type predicate: x is T
		return j;
	}
	/** Drop ": T" (or "?: T", "!: T") at i if there; returns the index after it. */
	annot(i) {
		let j = i;
		if ((this.s(j) === '?' || this.s(j) === '!') && this.s(j + 1) === ':') { this.cut(j, j + 1); j++; }
		else if (this.s(j) === '?' && [',', ')', '='].includes(this.s(j + 1))) { this.cut(j, j + 1); return j + 1; }
		if (this.s(j) !== ':') return j;
		const e = this.type(j + 1);
		if (e < 0) throw new Error('type expected at ' + this.where(j + 1));
		this.cut(j, e);
		return e;
	}
	where(i) { const k = this.S[Math.min(i, this.S.length - 1)]; return 'line ' + (this.T.slice(0, k).map(t => t.s).join('').split('\n').length) + ' (' + this.s(i) + ')'; }

	// ---- statements and expressions
	run() { this.expr(0, this.S.length); }
	block(i, end) { this.expr(i, end); }

	/** `type X = ...;`, `interface X ... {}`, `declare ...;` at i: the index after it, or -1. */
	typeDecl(i) {
		const k = this.s(i);
		if (k === 'type') {
			let j = i + 2;
			if (this.s(j) === '<') j = this.matchAngle(j);
			if (this.s(j) !== '=') return -1;
			j = this.type(j + 1);
			if (j < 0) throw new Error('type alias at ' + this.where(i));
			return this.s(j) === ';' ? j + 1 : j;
		}
		if (k === 'interface') { let j = i; while (this.s(j) !== '{') j++; return this.match(j); }
		if (k === 'declare') { let j = i; while (this.s(j) !== ';' && this.s(j) !== '{') j++; return this.s(j) === '{' ? this.match(j) : j + 1; }
		return -1;
	}

	/**
	 * Scan the tokens from i to end, one bracket level, erasing types; brackets are entered recursively (a { as a block
	 * or an object literal, a ( as parameters or an expression, ...). Returns end.
	 */
	expr(i, end) {
		let decl = null;          // in a let/const/var list: 'name' (a declarator's name comes next), 'after', 'init'
		while (i < end) {
			const t = this.tok(i), s = t.s;
			const prev = i > 0 ? this.tok(i - 1) : null;
			const member = prev && prev.t === 'p' && (prev.s === '.' || prev.s === '?.');
			if (t.t === 'id' && !member) {
				// declarations that are only types (two identifiers in a row: never JavaScript)
				if (s === 'export' && ['type', 'interface', 'declare'].includes(this.s(i + 1)) && this.isId(i + 2)) {
					const e = this.typeDecl(i + 1); if (e > 0) { this.cut(i, e); i = e; continue; }
				}
				if (['type', 'interface', 'declare'].includes(s) && this.isId(i + 1)) {
					const e = this.typeDecl(i); if (e > 0) { this.cut(i, e); i = e; continue; }
				}
				if (s === 'abstract' && this.s(i + 1) === 'class') { this.cutWord(i); i++; continue; }
				if (s === 'import' && this.s(i + 1) !== '(' && this.s(i + 1) !== '.') {
					const e = this.until(i, ';') + 1;
					if (this.s(i + 1) === 'type') this.cut(i, e);
					i = e; continue;
				}
				if (s === 'export' && (this.s(i + 1) === '{' || this.s(i + 1) === '*')) { i = this.until(i, ';') + 1; continue; }
				if ((s === 'let' || s === 'const' || s === 'var') && (this.isId(i + 1) || this.s(i + 1) === '{' || this.s(i + 1) === '[')) { decl = 'name'; i++; continue; }
				if (s === 'function') { i = this.func(i + 1); continue; }
				if (s === 'class') { i = this.klass(i + 1); continue; }
				if (s === 'as' && prev && this.endsExpr(prev) && !(this.s(i + 1) === ',' || this.s(i + 1) === ')')) {
					const e = this.type(i + 1); if (e < 0) throw new Error('as: type expected at ' + this.where(i));
					this.cut(i, e, true); i = e; continue;
				}
				if (s === 'catch' && this.s(i + 1) === '(') {
					const close = this.match(i + 1);
					if (this.isId(i + 2)) this.annot(i + 3);
					i = close; continue;
				}
				if (decl === 'name') { decl = 'after'; i = this.annot(i + 1); continue; }
			}
			if (t.t === 'id') {
				// a generic call or new: f<T>(...)
				if (this.s(i + 1) === '<') {
					const e = this.matchAngle(i + 1);
					if (e > 0 && this.s(e) === '(' && this.typeArgs(i + 1, e)) { this.cut(i + 1, e); i = e; continue; }
				}
				i++; continue;
			}
			if (t.t === 'p') {
				if (s === ';') { decl = null; i++; continue; }
				if (s === ',' && (decl === 'init' || decl === 'after')) { decl = 'name'; i++; continue; }
				if (s === '=' && decl === 'after') { decl = 'init'; i++; continue; }
				if (s === '!' && prev && this.endsExpr(prev) && !['=', '=='].includes(this.s(i + 1))) { this.cut(i, i + 1); i++; continue; }
				if ((s === '{' || s === '[') && decl === 'name') { const e = this.match(i); i = this.annot(e); decl = 'after'; continue; }   // destructuring
				if (s === '(') { i = this.paren(i); continue; }
				if (s === '[') { const e = this.match(i); this.expr(i + 1, e - 1); i = e; continue; }
				if (s === '{') {
					const e = this.match(i);
					if (this.isObject(i)) this.object(i + 1, e - 1); else this.expr(i + 1, e - 1);
					i = e; continue;
				}
				i++; continue;
			}
			if (t.t === 'tplh') { const e = this.match(i); this.tplParts(i, e); i = e; continue; }
			i++;
		}
		return i;
	}

	until(i, what) { while (this.s(i) !== what) i++; return i; }

	tplParts(i, e) {
		let a = i + 1;
		for (let j = i + 1; j < e; j++) {
			const t = this.tok(j);
			if (t.t === 'tplh') { j = this.match(j) - 1; continue; }
			if (t.t === 'tplm' || t.t === 'tplt') { this.expr(a, j); a = j + 1; }
		}
	}

	endsExpr(t) { return t.t === 'id' && !KEYWORDS.has(t.s) || t.t === 'num' || t.t === 'str' || t.t === 'tplt' || t.t === 'p' && (t.s === ')' || t.s === ']'); }

	/** Whether the `<...>` from a to e is a list of types (so that `f<T>(x)` is a generic call, not comparisons). */
	typeArgs(a, e) {
		let j = a + 1;
		for (;;) {
			const k = this.type(j);
			if (k < 0) return false;
			if (k === e - 1 && this.s(k) === '>') return true;
			if (this.s(k) !== ',') return false;
			j = k + 1;
		}
	}

	/** Whether the { at i opens an object literal (not a block). */
	isObject(i) {
		const p = i > 0 ? this.tok(i - 1) : null;
		if (!p) return false;
		if (p.t === 'id') return ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'].includes(p.s) && p.s !== 'case';
		if (p.t !== 'p') return false;
		if ([')', ';', '{', '}', '=>'].includes(p.s)) return false;
		if (p.s === ':') return this.colonIsInExpression(i - 1);
		return true;
	}
	colonIsInExpression(i) {
		// a : after a case label or a statement label opens a block; in a ternary or an object it opens an object
		let d = 0;
		for (let j = i - 1; j >= 0; j--) {
			const s = this.s(j);
			if (s === ')' || s === ']' || s === '}') d++;
			else if (s === '(' || s === '[' || s === '{') { if (d === 0) return s !== '{'; d--; }
			else if (d === 0 && (s === 'case' || s === 'default')) return false;
			else if (d === 0 && s === '?') return true;
			else if (d === 0 && s === ';') return false;
		}
		return false;
	}

	/** An object literal's members from i to end. */
	object(i, end) {
		while (i < end) {
			let j = i;
			if (this.s(j) === '...') { j = this.expr(j + 1, this.memberEnd(j + 1, end)); i = this.s(j) === ',' ? j + 1 : j; continue; }
			while (['get', 'set', 'async'].includes(this.s(j)) && !['(', ':', ',', '}'].includes(this.s(j + 1)) && j + 1 < end) j++;
			if (this.s(j) === '*') j++;
			if (this.s(j) === '[') j = this.match(j); else j++;
			if (this.s(j) === '(') { j = this.params(j); j = this.retType(j); j = this.body(j); }
			else if (this.s(j) === ':') { const e = this.memberEnd(j + 1, end); this.expr(j + 1, e); j = e; }
			else { const e = this.memberEnd(j, end); this.expr(j, e); j = e; }
			i = this.s(j) === ',' ? j + 1 : j;
		}
	}
	/** The index of the , that ends an object member (or end). */
	memberEnd(i, end) {
		for (let j = i; j < end;) {
			const s = this.s(j);
			if (s === ',') return j;
			if (s === '(' || s === '[' || s === '{' || this.tok(j).t === 'tplh') { j = this.match(j); continue; }
			j++;
		}
		return end;
	}

	/** ( at i: an arrow function's parameters, or a parenthesized expression or call arguments. */
	paren(i) {
		const e = this.match(i);
		if (this.s(e) === '=>') { this.params(i); return e; }
		if (this.s(e) === ':') {
			const k = this.type(e + 1);
			if (k > 0 && this.s(k) === '=>') { this.params(i); this.cut(e, k); return k; }
		}
		this.expr(i + 1, e - 1);
		return e;
	}

	/** A parameter list at i (the open paren): erases each parameter's type; returns the index after the ). */
	params(i) {
		const e = this.match(i);
		let j = i + 1;
		while (j < e - 1) {
			if (this.s(j) === 'this' && this.s(j + 1) === ':') {     // a this parameter: dropped
				const k = this.type(j + 2); this.cut(j, this.s(k) === ',' ? k + 1 : k); j = this.s(k) === ',' ? k + 1 : k; continue;
			}
			while (MODIFIERS.has(this.s(j)) && this.isId(j + 1)) { this.cutWord(j); j++; }
			if (this.s(j) === '...') j++;
			if (this.s(j) === '{' || this.s(j) === '[') { const m = this.match(j); this.expr(j + 1, m - 1); j = m; }
			else j++;
			j = this.annot(j);
			if (this.s(j) === '=') { const m = this.memberEnd(j + 1, e - 1); this.expr(j + 1, m); j = m; }
			if (this.s(j) === ',') j++;
		}
		return e;
	}
	retType(j) {
		if (this.s(j) !== ':') return j;
		const e = this.type(j + 1);
		if (e < 0) throw new Error('return type at ' + this.where(j));
		this.cut(j, e);
		return e;
	}
	body(j) {
		if (this.s(j) !== '{') return j;
		const e = this.match(j);
		this.block(j + 1, e - 1);
		return e;
	}

	/** After `function`: name, type parameters, parameters, return type, body. */
	func(i) {
		if (this.s(i) === '*') i++;
		if (this.isId(i)) i++;
		if (this.s(i) === '<') { const e = this.matchAngle(i); this.cut(i, e); i = e; }
		i = this.params(i);
		i = this.retType(i);
		if (this.s(i) === ';') { return i + 1; }        // an overload signature (not in the runtime)
		return this.body(i);
	}

	/** After `class`: name, type parameters, extends (with type arguments), implements, body. */
	klass(i) {
		if (this.isId(i) && this.s(i) !== 'extends' && this.s(i) !== 'implements') i++;
		if (this.s(i) === '<') { const e = this.matchAngle(i); this.cut(i, e); i = e; }
		if (this.s(i) === 'extends') {
			i++;
			while (this.s(i) !== '{' && this.s(i) !== 'implements') {
				if (this.s(i) === '<') { const e = this.matchAngle(i); if (e > 0) { this.cut(i, e); i = e; continue; } }
				if (this.s(i) === '(') { i = this.paren(i); continue; }
				i++;
			}
		}
		if (this.s(i) === 'implements') { let j = i; while (this.s(j) !== '{') j++; this.cut(i, j, true); i = j; }
		const e = this.match(i);
		this.classBody(i + 1, e - 1);
		return e;
	}

	classBody(i, end) {
		while (i < end) {
			if (this.s(i) === ';') { i++; continue; }
			let j = i;
			// modifiers (dropped) and JavaScript's own prefixes (kept)
			for (;;) {
				const s = this.s(j), nx = this.s(j + 1);
				const prefix = this.isId(j) && !['(', '=', ';', ':', '?', '!', '<', '}'].includes(nx);
				if (MODIFIERS.has(s) && prefix) { this.cutWord(j); j++; continue; }
				if (['static', 'get', 'set', 'async'].includes(s) && prefix) { j++; continue; }
				if (s === 'static' && nx === '{') { const e = this.match(j + 1); this.block(j + 2, e - 1); j = -e; break; }
				break;
			}
			if (j < 0) { i = -j; continue; }
			if (this.s(j) === '*') j++;
			// an index signature: dropped
			if (this.s(j) === '[' && this.isId(j + 1) && this.s(j + 2) === ':') {
				let k = this.match(j); k = this.type(k + 1); if (this.s(k) === ';') k++;
				this.cut(i, k); i = k; continue;
			}
			if (this.s(j) === '[') j = this.match(j); else j++;
			if (this.s(j) === '?' || (this.s(j) === '!' && this.s(j + 1) === ':')) { this.cut(j, j + 1); j++; }
			if (this.s(j) === '<') { const e = this.matchAngle(j); this.cut(j, e); j = e; }
			if (this.s(j) === '(') {
				j = this.params(j);
				j = this.retType(j);
				if (this.s(j) === ';') { this.cut(i, j + 1); i = j + 1; continue; }    // an overload or abstract method
				i = this.body(j);
				continue;
			}
			j = this.annot(j);
			if (this.s(j) === '=') {
				let k = j + 1;
				while (k < end && this.s(k) !== ';') { if (['(', '[', '{'].includes(this.s(k)) || this.tok(k).t === 'tplh') k = this.match(k); else k++; }
				this.expr(j + 1, k);
				j = k;
			}
			if (this.s(j) === ';') j++;
			i = j;
		}
	}
}

/** Drop the imported names that no longer occur as values, and an import left with none (tsc elides them too). */
function dropTypeOnlyImports(js) {
	const er = new Eraser(js);
	const S = er.S, T = er.T;
	let changed = false;
	const usedOutside = (nm, i, e) => S.some((sk, j) => (j < i || j > e) && T[sk].t === 'id' && T[sk].s === nm && er.s(j - 1) !== '.');
	for (let i = 0; i < S.length; i++) {
		if (er.s(i) !== 'import' || i > 0 && er.s(i - 1) === '.' || er.s(i + 1) === '(') continue;
		let e = i; while (er.s(e) !== ';') e++;
		const specs = [];         // [first token, last token, local name]
		let k = i + 1;
		if (er.isId(k) && er.s(k) !== 'from') { specs.push([k, k, er.s(k)]); k++; if (er.s(k) === ',') k++; }      // a default import
		if (er.s(k) === '*' && er.s(k + 1) === 'as') specs.push([k, k + 2, er.s(k + 2)]);
		else if (er.s(k) === '{') {
			const close = er.match(k);
			let a = k + 1;
			for (let q = k + 1; q < close; q++)
				if (er.s(q) === ',' || q === close - 1) { if (q > a) specs.push([a, q - 1, er.s(q - 1)]); a = q + 1; }
		}
		if (specs.length === 0) continue;               // import 'x' (for its effects)
		const unused = specs.filter(sp => !usedOutside(sp[2], i, e));
		if (unused.length === 0) continue;
		changed = true;
		if (unused.length === specs.length) { er.cut(i, e + 1); continue; }
		for (const [a, b] of unused) {
			if (er.s(b + 1) === ',') er.cut(a, b + 2); else if (er.s(a - 1) === ',') er.cut(a - 1, b + 1, false); else er.cut(a, b + 1);
		}
	}
	return changed ? er.out() : js;
}

export function ts2js(src, name) {
	const er = new Eraser(src);
	er.run();
	let js = er.out();
	js = dropTypeOnlyImports(js);
	if (name) js = js.replace(/^\/\/ ([\w.-]+)\.ts /, (m, b) => `// ${b}.js `);
	return js;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	const a = process.argv.slice(2);
	if (a.length < 2 || a.length % 2) { console.error('usage: ts2js.mjs IN.ts OUT.js [IN2.ts OUT2.js ...]'); process.exit(2); }
	for (let k = 0; k < a.length; k += 2) {
		const src = fs.readFileSync(a[k], 'utf8');
		fs.mkdirSync(path.dirname(a[k + 1]), { recursive: true });
		fs.writeFileSync(a[k + 1], ts2js(src, path.basename(a[k])));
	}
}
