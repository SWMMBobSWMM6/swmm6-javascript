// JsFn.cs - method bodies: C# statements and expressions (Roslyn IOperation trees) to JavaScript. A copy of TsFn.cs
// (the TypeScript translator's) in which declarations carry no types and casts are dropped; every expression and
// statement is written as TsFn writes it (JS.md lists the changes).
//
// Numbers keep C#'s unchecked semantics exactly (TS.md): every int result is normalised with | 0, every uint result
// with >>> 0, every float result with Math.fround; long and ulong values (number while safe, bigint otherwise) go
// through cpp.L's helpers. No statement is ever hoisted out of an expression: what C# evaluates inside an expression
// is written as a comma expression over the function's own temporaries ($t1, ...), so the order of evaluation and
// short-circuiting stay C#'s. Names the translator invents start with $, which no C# identifier can.
// Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see AI-USE.md and js/README.md.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

public static partial class Cs2Js
{
    /// <summary>A runtime helper the translator emits on its own (not a member of the C# runtime): recorded in the manifest.</summary>
    static string H(string name, string what) { Use("helper " + name, name + "  -- " + what); return name; }

public sealed class JsFn
{
    readonly IMethodSymbol? method;
    readonly INamedTypeSymbol cls;
    readonly Dictionary<ISymbol, string> names;
    readonly HashSet<string> used;
    readonly int[] tmp;
    readonly List<string> prologue = new();
    readonly List<string> temps = new();
    readonly ITypeSymbol? retType;
    readonly bool retRef;
    readonly Stack<string> condAccess = new();
    readonly Stack<string> implicitRecv = new();
    public IMethodSymbol? CurrentCtor;
    public readonly HashSet<string> ReadParams;
    readonly HashSet<ISymbol> hoistedLocals;
    readonly Dictionary<ILabelSymbol, string> breakLabels = new(SymbolEqualityComparer.Default);
    Dictionary<ILabelSymbol, int>? gotoLabels;
    string? rethrowVar;

    public JsFn(IMethodSymbol? m, INamedTypeSymbol c)
    {
        method = m; cls = c;
        names = new(SymbolEqualityComparer.Default); used = new(); tmp = new int[1];
        retType = m?.ReturnType; retRef = m != null && m.RefKind != RefKind.None;
        ReadParams = new();
        hoistedLocals = new(SymbolEqualityComparer.Default);
    }

    JsFn(JsFn parent, IMethodSymbol lambda)
    {
        method = lambda; cls = parent.cls;
        names = parent.names; used = parent.used; tmp = parent.tmp;
        retType = lambda.ReturnType; retRef = lambda.RefKind != RefKind.None;
        ReadParams = parent.ReadParams;
        hoistedLocals = parent.hoistedLocals;
        foreach (var s in parent.condAccess.Reverse()) condAccess.Push(s);
        foreach (var s in parent.implicitRecv.Reverse()) implicitRecv.Push(s);
    }

    string Fresh(string b) { tmp[0]++; return "$" + b + tmp[0]; }

    /// <summary>A temporary of this function (declared once, at its top).</summary>
    string Temp() { var t = Fresh("t"); temps.Add(t); return t; }

    string Declare(ISymbol s, string name)
    {
        var n = Id(name);
        if (n == "_" || n == "__") n = "$discard";
        var b = n; int k = 2;
        while (used.Contains(n)) n = b + "_" + k++;
        used.Add(n);
        names[s] = n;
        return n;
    }

    static bool Boxed(ISymbol s) => boxed.Contains(s);

    /// <summary>"new cpp.Cell" (an address-taken local's storage), the arguments to follow.</summary>
    static string NewCell(ITypeSymbol t) { Use("new cell (an address-taken local or parameter)", "new cpp.Cell(v): a Ref whose value is the field v"); return "new cpp.Cell"; }
    static string NewCellAny() { Use("new cell (an address-taken local or parameter)", "new cpp.Cell(v): a Ref whose value is the field v"); return "new cpp.Cell"; }

    /// <summary>Declare a parameter; a parameter whose address is taken is renamed and copied into its cell by the prologue.</summary>
    public string DeclareParam(IParameterSymbol p)
    {
        var n = Declare(p, p.Name);
        if (p.RefKind is RefKind.Ref or RefKind.Out or RefKind.In) return n;
        if (Boxed(p))
        {
            var pn = n + "$p";
            used.Add(pn);
            prologue.Add("let " + n + " = " + NewCell(p.Type) + "(" + pn + ");");
            return pn;
        }
        return n;
    }

    /// <summary>A constructor parameter bound by hand (a class with several constructors): its variable and how to set it.</summary>
    public (string name, string set) BindCtorParam(IParameterSymbol p, string v)
    {
        var n = names.TryGetValue(p, out var ex) ? ex : Declare(p, p.Name);
        if (Boxed(p) && p.RefKind == RefKind.None) return (n, n + " = " + NewCell(p.Type) + "(" + v + ");");
        return (n, n + " = " + v + ";");
    }

    public string Prologue(int ind)
    {
        var sb = new StringBuilder();
        foreach (var h in prologue) sb.Append(Ind(ind)).Append(h).Append('\n');
        if (temps.Count > 0) sb.Append(Ind(ind)).Append("let ").Append(string.Join(", ", temps)).Append(";\n");
        return sb.ToString();
    }

    public bool HasTemps => temps.Count > 0;

    /// <summary>A field initializer that needed temporaries: an arrow function called at once declares them.</summary>
    public string WrapTemps(string val)
    {
        if (temps.Count == 0 && prologue.Count == 0) return val;
        var s = "(() => { " + string.Concat(prologue.Select(p => p + " ")) + (temps.Count > 0 ? "let " + string.Join(", ", temps) + "; " : "") + "return " + Strip(val) + "; })()";
        temps.Clear(); prologue.Clear();
        return s;
    }

    // -------------------------------------------------------------------------------------------- statements
    static string Ind(int n) => new string('\t', n);

    public string Body(IOperation op, IMethodSymbol m, int ind)
    {
        var lines = new List<string>();
        var ops = op is IBlockOperation b ? b.Operations.ToList() : op is IMethodBodyOperation mb && mb.BlockBody != null ? mb.BlockBody.Operations.ToList() : new List<IOperation> { op };
        bool canEnd;
        if (op.Descendants().Any(d => d is IBranchOperation br && br.BranchKind == BranchKind.GoTo))
            canEnd = Dispatch(ops, lines, ind);
        else
            canEnd = Block(ops, lines, ind);
        if (canEnd && !(m.ReturnsVoid || m.MethodKind == MethodKind.Constructor || m.MethodKind == MethodKind.StaticConstructor))
            lines.Add(Ind(ind) + "throw new Error(\"unreachable\");");
        return string.Concat(lines.Select(l => l + "\n"));
    }

    /// <summary>goto: a method whose labels all sit in its top-level block becomes
    /// let $st = 0; $dispatch: for (;;) { switch ($st) { case 0: ... case 1: ... } break; }
    /// and goto Lk becomes { $st = k; continue $dispatch; }. The locals declared at the top level are declared before
    /// the loop (a case cannot hold a declaration another case uses).</summary>
    bool Dispatch(List<IOperation> ops, List<string> lines, int ind)
    {
        gotoLabels = new(SymbolEqualityComparer.Default);
        int k = 0;
        foreach (var o in ops) if (o is ILabeledOperation l) gotoLabels[l.Label] = ++k;
        if (ops.Any(o => o.Descendants().Any(d => d is ILabeledOperation) && o is not ILabeledOperation)) Todo("label below the top level of a method");
        var p = Ind(ind);
        var top = new List<IOperation>();
        foreach (var o in ops) top.Add(o is ILabeledOperation lo && lo.Operation != null ? lo.Operation : o);
        Hoist(top, lines, ind);
        lines.Add(p + "let $st = 0;");
        lines.Add(p + "$dispatch: for (;;) {");
        lines.Add(Ind(ind + 1) + "switch ($st) {");
        lines.Add(Ind(ind + 1) + "case 0:");
        var seg = new List<IOperation>();
        void FlushSeg() { Block(seg, lines, ind + 2); seg.Clear(); }
        foreach (var o in ops)
        {
            if (o is ILabeledOperation l)
            {
                FlushSeg();
                lines.Add(Ind(ind + 1) + "case " + gotoLabels[l.Label] + ":");
                if (l.Operation != null) seg.Add(l.Operation);
            }
            else seg.Add(o);
        }
        FlushSeg();
        lines.Add(Ind(ind + 1) + "}");
        lines.Add(Ind(ind + 1) + "break;");
        lines.Add(p + "}");
        return true;
    }

    /// <summary>Declare, before the construct that needs it, every local declared directly among ops; the
    /// declarations themselves then become assignments.</summary>
    void Hoist(IEnumerable<IOperation> ops, List<string> lines, int ind)
    {
        foreach (var o in ops)
        {
            if (o is IUsingDeclarationOperation) Todo("using declaration in a switch section or a goto method");
            if (o is not IVariableDeclarationGroupOperation g) continue;
            foreach (var d in g.Declarations)
                foreach (var v in d.Declarators)
                {
                    var loc = v.Symbol;
                    var n = Declare(loc, loc.Name);
                    hoistedLocals.Add(loc);
                    if (loc.RefKind != RefKind.None) lines.Add(Ind(ind) + "let " + n + " = null;");
                    else if (Boxed(loc)) lines.Add(Ind(ind) + "let " + n + " = " + NewCell(loc.Type) + "(" + DefaultOf(loc.Type) + ");");
                    else lines.Add(Ind(ind) + "let " + n + " = " + DefaultOf(loc.Type) + ";");
                }
        }
    }

    /// <summary>Statements of a block. Returns whether the block can complete normally (used only to close a
    /// non-void function with a throw, as the TypeScript translator does).</summary>
    bool Block(IEnumerable<IOperation> ops, List<string> lines, int ind)
    {
        var list = ops.ToList();
        bool ends = true;
        for (int i = 0; i < list.Count; i++)
        {
            if (list[i] is IUsingDeclarationOperation ud)
                return UsingRest(ud, list.Skip(i + 1).ToList(), lines, ind) && ends;
            if (!Stmt(list[i], lines, ind)) ends = false;
            else if (!ends && list[i] is ILabeledOperation) ends = true;
        }
        return ends;
    }

    /// <summary>Variables an expression of the current statement declares (out var x): declared just before it.</summary>
    List<string> pendingDecls = new();

    bool Stmt(IOperation op, List<string> lines, int ind)
    {
        var saved = pendingDecls;
        pendingDecls = new List<string>();
        int at = lines.Count;
        try
        {
            var r = StmtTry(op, lines, ind);
            if (pendingDecls.Count > 0) lines.InsertRange(at, pendingDecls.Select(d => Ind(ind) + d));
            return r;
        }
        finally { pendingDecls = saved; }
    }

    bool StmtTry(IOperation op, List<string> lines, int ind)
    {
        try { return StmtInner(op, lines, ind); }
        catch (global::Todo e)
        {
            lines.Add(Ind(ind) + "throw new Error(\"TODO " + Esc(e.Message) + "\");");
            return true;
        }
    }

    public static string Esc(string s) => s.Replace("\\", "\\\\").Replace("\"", "'").Replace("\n", " ");

    bool StmtInner(IOperation op, List<string> lines, int ind)
    {
        var p = Ind(ind);
        switch (op)
        {
            case IBlockOperation b:
                {
                    lines.Add(p + "{");
                    var c = Block(b.Operations, lines, ind + 1);
                    lines.Add(p + "}");
                    return c;
                }
            case IVariableDeclarationGroupOperation g:
                foreach (var d in g.Declarations)
                    foreach (var v in d.Declarators) LocalDecl(v, d.Initializer, lines, ind);
                return true;
            case IExpressionStatementOperation es:
                {
                    var s = StmtExpr(es.Operation);
                    if (s.Length > 0) lines.Add(p + s + ";");
                    return true;
                }
            case IReturnOperation r:
                {
                    string? v = null;
                    if (r.ReturnedValue != null) v = retRef ? RefOf(r.ReturnedValue) : Value(r.ReturnedValue, retType);
                    lines.Add(p + "return" + (v != null ? " " + Strip(v) : "") + ";");
                    return false;
                }
            case IConditionalOperation c:
                {
                    lines.Add(p + "if (" + Strip(X(c.Condition)) + ") {");
                    var a = Sub(c.WhenTrue, lines, ind + 1);
                    if (c.WhenFalse == null) { lines.Add(p + "}"); return true; }
                    lines.Add(p + "} else {");
                    var b2 = Sub(c.WhenFalse, lines, ind + 1);
                    lines.Add(p + "}");
                    return a || b2;
                }
            case IWhileLoopOperation w: return While(w, lines, ind);
            case IForLoopOperation f: return For(f, lines, ind);
            case IForEachLoopOperation fe: return ForEach(fe, lines, ind);
            case IBranchOperation br: Branch(br, lines, ind); return false;
            case ILabeledOperation l:
                Todo0("label outside a dispatch method");
                if (l.Operation != null) return Stmt(l.Operation, lines, ind);
                return true;
            case ISwitchOperation sw: return Switch(sw, lines, ind);
            case ITryOperation t: return Try(t, lines, ind);
            case IUsingOperation u: return Using(u, lines, ind);
            case IThrowOperation th:
                {
                    var v = th.Exception == null ? Rethrow() : X(th.Exception);
                    lines.Add(p + "throw " + Strip(v) + ";");
                    return false;
                }
            case IEmptyOperation: return true;
            case IUsingDeclarationOperation ud: return UsingRest(ud, new List<IOperation>(), lines, ind);
            case ILockOperation lk:
                Note("lock statement (single-threaded: the body runs)");
                lines.Add(p + "{");
                lines.Add(Ind(ind + 1) + StmtExpr(lk.LockedValue) + ";");
                var le = Sub(lk.Body, lines, ind + 1);
                lines.Add(p + "}");
                return le;
            case ILocalFunctionOperation: Todo("local function"); return true;
        }
        Todo("statement " + op.Kind);
        return true;
    }

    void LocalDecl(IVariableDeclaratorOperation v, IVariableInitializerOperation? outerInit, List<string> lines, int ind)
    {
        var p = Ind(ind);
        var loc = v.Symbol;
        var init = v.Initializer ?? outerInit;
        bool hoisted = hoistedLocals.Contains(loc);
        if (loc.RefKind != RefKind.None)
        {
            var a = init == null ? "null" : RefOf(init.Value);
            var n0 = hoisted ? names[loc] : Declare(loc, loc.Name);
            lines.Add(p + (hoisted ? "" : "let ") + n0 + " = " + Strip(a) + ";");
            return;
        }
        string val = init == null ? DefaultOf(loc.Type) : Value(init.Value, loc.Type);
        if (hoisted)
        {
            var hn = names[loc];
            if (init == null) return;
            lines.Add(p + (Boxed(loc) ? hn + ".v" : hn) + " = " + Strip(val) + ";");
            return;
        }
        var name = Declare(loc, loc.Name);
        if (Boxed(loc)) { lines.Add(p + "let " + name + " = " + NewCell(loc.Type) + "(" + Strip(val) + ");"); return; }
        lines.Add(p + "let " + name + " = " + Strip(val) + ";");
    }

    static string Strip(string s)
    {
        if (s.Length > 1 && s[0] == '(' && s[^1] == ')' && Balanced(s, 1, s.Length - 1) && !TopComma(s, 1, s.Length - 1)) return s.Substring(1, s.Length - 2);
        return s;
    }

    /// <summary>Whether s[from..to) has balanced brackets (string literals skipped).</summary>
    static bool Balanced(string s, int from, int to)
    {
        int d = 0;
        for (int i = from; i < to; i++)
        {
            var ch = s[i];
            if (ch == '"') { i = SkipStr(s, i); continue; }
            if (ch == '(' || ch == '[' || ch == '{') d++;
            else if (ch == ')' || ch == ']' || ch == '}') { d--; if (d < 0) return false; }
        }
        return d == 0;
    }

    static bool TopComma(string s, int from, int to)
    {
        int d = 0;
        for (int i = from; i < to; i++)
        {
            var ch = s[i];
            if (ch == '"') { i = SkipStr(s, i); continue; }
            if (ch == '(' || ch == '[' || ch == '{') d++;
            else if (ch == ')' || ch == ']' || ch == '}') d--;
            else if (ch == ',' && d == 0) return true;
        }
        return false;
    }

    static int SkipStr(string s, int i)
    {
        for (i++; i < s.Length; i++)
        {
            if (s[i] == '\\') { i++; continue; }
            if (s[i] == '"') return i;
        }
        return i;
    }

    bool Sub(IOperation op, List<string> lines, int ind)
    {
        if (op is IBlockOperation b) return Block(b.Operations, lines, ind);
        return Stmt(op, lines, ind);
    }

    static bool HasBreakOut(IOperation loop, ILabelSymbol? exit)
    {
        if (exit == null) return false;
        return loop.Descendants().Any(d => d is IBranchOperation b && b.BranchKind == BranchKind.Break && SymbolEqualityComparer.Default.Equals(b.Target, exit));
    }

    static bool IsTrue(IOperation? c) => c == null || c.ConstantValue.HasValue && c.ConstantValue.Value is true;

    bool While(IWhileLoopOperation w, List<string> lines, int ind)
    {
        var p = Ind(ind);
        var brk = HasBreakOut(w, w.ExitLabel);
        if (w.ConditionIsTop)
        {
            var cond = w.Condition == null ? "true" : X(w.Condition);
            lines.Add(p + "while (" + Strip(cond) + ") {");
            Sub(w.Body, lines, ind + 1);
            lines.Add(p + "}");
            return !IsTrue(w.Condition) || brk;
        }
        lines.Add(p + "do {");
        Sub(w.Body, lines, ind + 1);
        lines.Add(p + "} while (" + Strip(X(w.Condition!)) + ");");
        return !IsTrue(w.Condition) || brk;
    }

    bool For(IForLoopOperation f, List<string> lines, int ind)
    {
        // the loop's variables are declared once, outside the loop, as C# has them (one variable for all iterations)
        var p = Ind(ind);
        lines.Add(p + "{");
        foreach (var b in f.Before) Stmt(b, lines, ind + 1);
        var cond = f.Condition == null ? "" : Strip(X(f.Condition));
        var posts = new List<string>();
        foreach (var a in f.AtLoopBottom)
        {
            var s = a is IExpressionStatementOperation es ? StmtExpr(es.Operation) : Todo("for-loop step " + a.Kind);
            if (s.Length > 0) posts.Add(s);
        }
        lines.Add(Ind(ind + 1) + "for (; " + cond + "; " + string.Join(", ", posts) + ") {");
        Sub(f.Body, lines, ind + 2);
        lines.Add(Ind(ind + 1) + "}");
        lines.Add(p + "}");
        return !IsTrue(f.Condition) || HasBreakOut(f, f.ExitLabel);
    }

    bool ForEach(IForEachLoopOperation fe, List<string> lines, int ind)
    {
        var p = Ind(ind);
        var coll = fe.Collection is IConversionOperation cv && cv.IsImplicit ? cv.Operand : fe.Collection;
        var ct = coll.Type!;
        var src = X(coll);
        if (fe.LoopControlVariable is not IVariableDeclaratorOperation vd) { Todo("foreach variable"); return true; }
        var loc = vd.Symbol;
        string iter;
        if (ct is IArrayTypeSymbol) iter = src;
        else if (ct is INamedTypeSymbol ie && IsSystem(ie) && StripArity(ie.Name) == "IEnumerable") { iter = src; Use("foreach over IEnumerable<T> (a runtime member returning one)", "a JavaScript iterable"); }
        else { Todo("foreach over " + ct.ToDisplayString()); return true; }
        var name = Declare(loc, loc.Name);
        var raw = Fresh("e");
        lines.Add(p + "for (const " + raw + " of " + Strip(iter) + ") {");
        if (Boxed(loc)) lines.Add(Ind(ind + 1) + "let " + name + " = " + NewCell(loc.Type) + "(" + raw + ");");
        else lines.Add(Ind(ind + 1) + "let " + name + " = " + raw + ";");
        Sub(fe.Body, lines, ind + 1);
        lines.Add(p + "}");
        return true;
    }

    void Branch(IBranchOperation br, List<string> lines, int ind)
    {
        var p = Ind(ind);
        switch (br.BranchKind)
        {
            case BranchKind.Break:
                if (breakLabels.TryGetValue(br.Target, out var lab)) { lines.Add(p + "break " + lab + ";"); return; }
                lines.Add(p + "break;");
                return;
            case BranchKind.Continue: lines.Add(p + "continue;"); return;
            case BranchKind.GoTo:
                if (gotoLabels != null && gotoLabels.TryGetValue(br.Target, out var k)) { lines.Add(p + "{ $st = " + k + "; continue $dispatch; }"); return; }
                Todo("goto outside a dispatch method");
                return;
        }
        Todo("branch " + br.BranchKind);
    }

    bool Switch(ISwitchOperation sw, List<string> lines, int ind)
    {
        var p = Ind(ind);
        var vt = sw.Value.Type!;
        var u = Under(vt);
        var v = X(sw.Value);
        bool anyBreak = HasBreakOut(sw, sw.ExitLabel);
        bool hasDefault = sw.Cases.Any(c => c.Clauses.Any(cl => cl is IDefaultCaseClauseOperation));
        // the locals a section declares are in scope in every section (C#): declare them before the switch
        Hoist(sw.Cases.SelectMany(c => c.Body), lines, ind);
        // JavaScript's switch compares with ===, exact for the canonical values of every integer type, for a
        // long whose cases are safe numbers (a bigint value is then never equal to one), for bool and for string
        bool jsSwitch = IsIntegral(u) || u.SpecialType is SpecialType.System_Boolean or SpecialType.System_String;
        foreach (var c in sw.Cases)
            foreach (var cl in c.Clauses)
            {
                if (cl is ISingleValueCaseClauseOperation sv && IsLong(u) && sv.Value.ConstantValue.HasValue && !SafeInt(sv.Value.ConstantValue.Value)) jsSwitch = false;
                if (cl is not (ISingleValueCaseClauseOperation or IDefaultCaseClauseOperation)) jsSwitch = false;
            }
        if (!jsSwitch)
        {
            Note("switch written as an if-chain: " + vt.ToDisplayString());
            var t = Temp();
            var lab = Fresh("sw");
            breakLabels[sw.ExitLabel] = lab;
            lines.Add(p + lab + ": {");
            lines.Add(Ind(ind + 1) + t + " = " + Strip(v) + ";");
            bool first = true;
            bool canEnd = !hasDefault;
            IOperation[]? defBody = null;
            foreach (var c in sw.Cases)
            {
                var conds = new List<string>();
                foreach (var cl in c.Clauses)
                {
                    if (cl is IDefaultCaseClauseOperation) continue;
                    if (cl is ISingleValueCaseClauseOperation sv) conds.Add(IsLong(u) ? t + " == " + X(sv.Value) : t + " === " + X(sv.Value));
                    else Todo("case clause " + cl.CaseKind);
                }
                if (c.Clauses.Any(cl => cl is IDefaultCaseClauseOperation)) { defBody = c.Body.ToArray(); if (conds.Count == 0) continue; }
                lines.Add(Ind(ind + 1) + (first ? "if (" : "else if (") + string.Join(" || ", conds) + ") {");
                first = false;
                if (Block(c.Body, lines, ind + 2)) canEnd = true;
                lines.Add(Ind(ind + 1) + "}");
            }
            if (defBody != null)
            {
                lines.Add(Ind(ind + 1) + (first ? "{" : "else {"));
                if (Block(defBody, lines, ind + 2)) canEnd = true;
                lines.Add(Ind(ind + 1) + "}");
            }
            lines.Add(p + "}");
            return canEnd || anyBreak;
        }
        lines.Add(p + "switch (" + Strip(v) + ") {");
        bool lastEnds = true;
        foreach (var c in sw.Cases)
        {
            foreach (var cl in c.Clauses)
            {
                if (cl is IDefaultCaseClauseOperation) lines.Add(p + "default:");
                else if (cl is ISingleValueCaseClauseOperation sv) lines.Add(p + "case " + Strip(Value(sv.Value, vt)) + ":");
            }
            lastEnds = Block(c.Body, lines, ind + 1);
        }
        lines.Add(p + "}");
        return lastEnds || anyBreak || !hasDefault || sw.Cases.Length == 0;
    }

    static bool SafeInt(object? v) => v switch
    {
        long l => l >= -9007199254740991L && l <= 9007199254740991L,
        ulong ul => ul <= 9007199254740991UL,
        _ => true
    };

    // -------------------------------------------------------------------------------------------- try, using
    string Rethrow() => rethrowVar ?? Todo("throw; outside a catch");

    /// <summary>try/catch/finally: one JavaScript catch tests the C# clauses in order with instanceof (a catch of
    /// System.Exception or object catches everything) and rethrows what none of them takes.</summary>
    bool Try(ITryOperation t, List<string> lines, int ind)
    {
        var p = Ind(ind);
        lines.Add(p + "try {");
        var ends = Block(t.Body.Operations, lines, ind + 1);
        if (t.Catches.Length > 0)
        {
            var ev = Fresh("e");
            lines.Add(p + "} catch (" + ev + ") {");
            bool first = true, all = false;
            foreach (var cc in t.Catches)
            {
                var et = cc.ExceptionType;
                bool catchAll = et.SpecialType == SpecialType.System_Object || et is INamedTypeSymbol en && IsSystem(en) && en.Name == "Exception";
                string test;
                if (catchAll) test = "";
                else if (et is INamedTypeSymbol nt && IsRuntime(nt)) { test = ev + " instanceof " + RuntimeClass(nt); Use("catch " + nt.ToDisplayString(), RuntimeClass(nt) + " (instanceof)"); }
                else if (et is INamedTypeSymbol ne && IsEngine(ne)) test = ev + " instanceof " + TypeIdent(ne);
                else { Todo("catch of " + et.ToDisplayString()); test = "false"; }
                if (cc.Filter != null) Todo("exception filter");
                lines.Add(Ind(ind + 1) + (catchAll ? (first ? "{" : "else {") : (first ? "if (" : "else if (") + test + ") {"));
                if (cc.ExceptionDeclarationOrExpression is IVariableDeclaratorOperation vd)
                {
                    var n = Declare(vd.Symbol, vd.Symbol.Name);
                    lines.Add(Ind(ind + 2) + (Boxed(vd.Symbol) ? "let " + n + " = " + NewCellAny() + "(" + ev + ");" : "let " + n + " = " + ev + ";"));
                }
                var saved = rethrowVar; rethrowVar = ev;
                if (Block(cc.Handler.Operations, lines, ind + 2)) ends = true;
                rethrowVar = saved;
                lines.Add(Ind(ind + 1) + "}");
                first = false;
                if (catchAll) { all = true; break; }
            }
            if (!all) lines.Add(Ind(ind + 1) + "else throw " + ev + ";");
        }
        if (t.Finally != null)
        {
            lines.Add(p + "} finally {");
            var f = Block(t.Finally.Operations, lines, ind + 1);
            if (!f) ends = false;
        }
        lines.Add(p + "}");
        return ends;
    }

    bool UsingRest(IUsingDeclarationOperation ud, List<IOperation> rest, List<string> lines, int ind)
    {
        var p = Ind(ind);
        var decls = ud.DeclarationGroup.Declarations.SelectMany(d => d.Declarators).ToList();
        foreach (var d in ud.DeclarationGroup.Declarations)
            foreach (var v in d.Declarators) LocalDecl(v, d.Initializer, lines, ind);
        lines.Add(p + "try {");
        var ends = Block(rest, lines, ind + 1);
        lines.Add(p + "} finally {");
        foreach (var v in decls.AsEnumerable().Reverse())
        {
            var n = Read(v.Symbol);
            lines.Add(Ind(ind + 1) + "if (" + n + " != null) " + n + ".Dispose();");
        }
        lines.Add(p + "}");
        Use("using: IDisposable.Dispose()", "Dispose()");
        return ends;
    }

    bool Using(IUsingOperation u, List<string> lines, int ind)
    {
        var p = Ind(ind);
        lines.Add(p + "{");
        var names0 = new List<string>();
        if (u.Resources is IVariableDeclarationGroupOperation g)
        {
            foreach (var d in g.Declarations)
                foreach (var v in d.Declarators) { LocalDecl(v, d.Initializer, lines, ind + 1); names0.Add(Read(v.Symbol)); }
        }
        else
        {
            var r = Fresh("res");
            lines.Add(Ind(ind + 1) + "const " + r + " = " + Strip(X(u.Resources)) + ";");
            names0.Add(r);
        }
        lines.Add(Ind(ind + 1) + "try {");
        var ends = Sub(u.Body, lines, ind + 2);
        lines.Add(Ind(ind + 1) + "} finally {");
        foreach (var n in names0.AsEnumerable().Reverse()) lines.Add(Ind(ind + 2) + "if (" + n + " != null) " + n + ".Dispose();");
        lines.Add(Ind(ind + 1) + "}");
        lines.Add(p + "}");
        Use("using: IDisposable.Dispose()", "Dispose()");
        return ends;
    }

    string Read(ILocalSymbol l) => Boxed(l) ? Name(l) + ".v" : l.RefKind != RefKind.None ? Name(l) + ".get()" : Name(l);

    string Name(ISymbol s)
    {
        if (!names.TryGetValue(s, out var n)) return Todo("unknown symbol " + s.Name);
        if (s is IParameterSymbol) ReadParams.Add(n);
        return n;
    }

    // -------------------------------------------------------------------------------------------- expression statements
    /// <summary>An expression used as a statement, without its semicolon.</summary>
    string StmtExpr(IOperation op)
    {
        switch (op)
        {
            case ISimpleAssignmentOperation a:
                {
                    if (a.IsRef) return RefRebind(a.Target, RefOf(a.Value));
                    CheckStructField(a.Target);
                    var v = Value(a.Value, a.Target.Type);
                    return Strip(AssignStmt(a.Target, v));
                }
            case ICompoundAssignmentOperation ca: return Strip(Compound(ca, true));
            case IIncrementOrDecrementOperation inc: return Strip(IncDec(inc, true));
            case IDiscardOperation: return "";
            case IConditionalAccessOperation ca:
                {
                    // a?.M();  ->  if (a != null) a.M();
                    var recv = X(ca.Operation);
                    string r = recv, test;
                    if (Trivial(recv)) test = r + " != null";
                    else { r = Temp(); test = "(" + r + " = " + Strip(recv) + ") != null"; }
                    condAccess.Push(r);
                    var inner = StmtExpr(ca.WhenNotNull);
                    condAccess.Pop();
                    return "if (" + test + ") " + inner;
                }
            default:
                return Strip(X(op));
        }
    }

    string RefRebind(IOperation target, string r)
    {
        if (target is ILocalReferenceOperation l && l.Local.RefKind != RefKind.None) return names[l.Local] + " = " + Strip(r);
        return Todo("ref reassignment of " + target.Kind);
    }

    void CheckStructField(IOperation target)
    {
        if (target is IFieldReferenceOperation f && IsRuntime(f.Field) && IsStructType(f.Field.ContainingType))
            Todo0("assignment to a field of a runtime struct (JavaScript shares struct values): " + f.Field.ContainingType.Name + "." + f.Field.Name);
    }

    // -------------------------------------------------------------------------------------------- places
    /// <summary>A location that is read and written (compound assignment, ++, --): Setup evaluates the parts that
    /// must be evaluated once, then Get reads and Set writes.</summary>
    sealed class Place { public List<string> Setup = new(); public string Get = ""; public Func<string, string> Set = null!; public bool SetYields; }

    static readonly Regex TrivialRx = new(@"^(this|[A-Za-z_$][\w$]*)(\.[A-Za-z_$][\w$]*)*$", RegexOptions.Compiled);
    static readonly Regex LiteralRx = new(@"^\(?-?[0-9][0-9.eE+\-]*n?\)?$", RegexOptions.Compiled);
    static bool Trivial(string s) => TrivialRx.IsMatch(s) || LiteralRx.IsMatch(s);

    /// <summary>s, or a temporary holding it when it must be evaluated once (a call, an index expression, or any
    /// non-constant when the value written may change it).</summary>
    string Once(string s, Place pl, bool strict)
    {
        if (LiteralRx.IsMatch(s) || s == "this" || !strict && TrivialRx.IsMatch(s)) return s;
        var t = Temp();
        pl.Setup.Add(t + " = " + Strip(s));
        return t;
    }

    Place PlaceOf(IOperation target, bool valuePure)
    {
        var pl = new Place();
        bool strict = !valuePure;
        switch (target)
        {
            case IConversionOperation cv when cv.Conversion.IsIdentity: return PlaceOf(cv.Operand, valuePure);
            case ILocalReferenceOperation l when l.Local.RefKind == RefKind.None:
                {
                    var n = Boxed(l.Local) ? Name(l.Local) + ".v" : Name(l.Local);
                    pl.Get = n; pl.Set = v => "(" + n + " = " + Strip(v) + ")"; pl.SetYields = true;
                    return pl;
                }
            case IParameterReferenceOperation pr when pr.Parameter.RefKind == RefKind.None:
                {
                    var n = Boxed(pr.Parameter) ? Name(pr.Parameter) + ".v" : Name(pr.Parameter);
                    pl.Get = n; pl.Set = v => "(" + n + " = " + Strip(v) + ")"; pl.SetYields = true;
                    return pl;
                }
            case IFieldReferenceOperation f:
                {
                    CheckStructField(f);
                    var fs = f.Field;
                    string n;
                    if (fs.IsStatic) n = StaticFieldOwner(fs) + "." + FieldName(fs);
                    else n = Once(Recv(f.Instance!), pl, strict) + "." + FieldName(fs);
                    pl.Get = n; pl.Set = v => "(" + n + " = " + Strip(v) + ")"; pl.SetYields = true;
                    return pl;
                }
            case IArrayElementReferenceOperation ae:
                {
                    var a = Once(Recv(ae.ArrayReference), pl, strict);
                    var i = Once(Index(ae.Indices[0]), pl, true);
                    var n = a + "[" + Strip(i) + "]";
                    pl.Get = n; pl.Set = v => "(" + n + " = " + Strip(v) + ")"; pl.SetYields = true;
                    return pl;
                }
            case IPropertyReferenceOperation pr when VecElem(pr, out var recv, out var field, out var idx):
                {
                    var a = Once(recv, pl, strict);
                    var i = Once(idx, pl, true);
                    var n = a + "." + field + "[" + Strip(i) + "]";
                    pl.Get = n; pl.Set = v => "(" + n + " = " + Strip(v) + ")"; pl.SetYields = true;
                    return pl;
                }
            case IPropertyReferenceOperation cp when IsCPtrIndexer(cp):
                {
                    var a = Once(Recv(cp.Instance!), pl, strict);
                    var i = Once(Index(cp.Arguments[0].Value), pl, true);
                    pl.Get = a + ".get(" + Strip(i) + ")"; pl.Set = v => a + ".set(" + Strip(i) + ", " + Strip(v) + ")"; pl.SetYields = false;
                    UseCPtr();
                    return pl;
                }
            case IPropertyReferenceOperation sp when !sp.Property.IsIndexer && sp.Property.SetMethod != null && sp.Property.RefKind == RefKind.None:
                {
                    var a = sp.Property.IsStatic ? RuntimeClass(sp.Property.ContainingType) : Once(Recv(sp.Instance!), pl, strict);
                    pl.Get = PropGet(sp, a); pl.Set = v => PropSet(sp, a, v); pl.SetYields = false;
                    return pl;
                }
        }
        var r = Once(RefOf(target), pl, true);
        pl.Get = r + ".get()"; pl.Set = v => r + ".set(" + Strip(v) + ")"; pl.SetYields = false;
        return pl;
    }

    /// <summary>Setup, then expr, as one expression.</summary>
    static string Seq(Place pl, string expr) => pl.Setup.Count == 0 ? expr : "(" + string.Join(", ", pl.Setup) + ", " + Strip(expr) + ")";

    /// <summary>A simple assignment as a statement (its value unused).</summary>
    string AssignStmt(IOperation target, string v)
    {
        // C# evaluates the target's receiver and indices, then the value, then stores: so does JavaScript's a[i] = v,
        // o.f = v, r.set(v), p.set(i, v)
        switch (target)
        {
            case IConversionOperation cv when cv.Conversion.IsIdentity: return AssignStmt(cv.Operand, v);
            case ILocalReferenceOperation l when l.Local.RefKind == RefKind.None: return (Boxed(l.Local) ? Name(l.Local) + ".v" : Name(l.Local)) + " = " + Strip(v);
            case IParameterReferenceOperation pr when pr.Parameter.RefKind == RefKind.None: return (Boxed(pr.Parameter) ? Name(pr.Parameter) + ".v" : Name(pr.Parameter)) + " = " + Strip(v);
            case IFieldReferenceOperation f: return Field(f) + " = " + Strip(v);
            case IArrayElementReferenceOperation ae: return Recv(ae.ArrayReference) + "[" + Strip(Index(ae.Indices[0])) + "] = " + Strip(v);
            case IPropertyReferenceOperation pr when VecElem(pr, out var recv, out var field, out var idx): return recv + "." + field + "[" + Strip(idx) + "] = " + Strip(v);
            case IPropertyReferenceOperation cp when IsCPtrIndexer(cp): UseCPtr(); return Recv(cp.Instance!) + ".set(" + Strip(Index(cp.Arguments[0].Value)) + ", " + Strip(v) + ")";
            case IPropertyReferenceOperation sp when !sp.Property.IsIndexer && sp.Property.SetMethod != null && sp.Property.RefKind == RefKind.None:
                return PropSet(sp, sp.Property.IsStatic ? RuntimeClass(sp.Property.ContainingType) : Recv(sp.Instance!), v);
        }
        return RefOf(target) + ".set(" + Strip(v) + ")";
    }

    /// <summary>A simple assignment whose value is used.</summary>
    string AssignExpr(ISimpleAssignmentOperation a)
    {
        CheckStructField(a.Target);
        var v = Value(a.Value, a.Target.Type);
        var s = AssignStmt(a.Target, v);
        if (IsYieldingAssign(a.Target)) return "(" + s + ")";
        // r.set(v) and p.set(i, v) have no value: keep it in a temporary
        var t = Temp();
        var s2 = AssignStmt(a.Target, t);
        return "(" + t + " = " + Strip(v) + ", " + s2 + ", " + t + ")";
    }

    bool IsYieldingAssign(IOperation target) => target switch
    {
        IConversionOperation cv when cv.Conversion.IsIdentity => IsYieldingAssign(cv.Operand),
        ILocalReferenceOperation l => l.Local.RefKind == RefKind.None,
        IParameterReferenceOperation p => p.Parameter.RefKind == RefKind.None,
        IFieldReferenceOperation => true,
        IArrayElementReferenceOperation => true,
        IPropertyReferenceOperation pr => VecElem(pr, out _, out _, out _),
        _ => false
    };

    string Compound(ICompoundAssignmentOperation ca, bool stmt)
    {
        var tt = ca.Target.Type!;
        var pl = PlaceOf(ca.Target, Pure(ca.Value));
        string nv;
        if (ca.OperatorMethod != null) nv = UserBinary(ca.OperatorMethod, pl.Get, Value(ca.Value, ca.OperatorMethod.Parameters[1].Type));
        else
        {
            // the operator's operand and result types, from the built-in operator Roslyn chose
            ITypeSymbol lt = tt, rtp = ca.Value.Type ?? tt, res = tt;
            if (ca.SemanticModel?.GetSymbolInfo(ca.Syntax).Symbol is IMethodSymbol bi && bi.Parameters.Length == 2)
            { lt = bi.Parameters[0].Type; rtp = bi.Parameters[1].Type; res = bi.ReturnType; }
            var l = Conv(pl.Get, tt, lt);
            var r = Value(ca.Value, rtp);
            nv = Conv(BinOp(ca.OperatorKind, lt, l, r), res, tt);
        }
        if (stmt || pl.SetYields) return Seq(pl, pl.Set(nv));
        var t = Temp();
        pl.Setup.Add(t + " = " + Strip(nv));
        pl.Setup.Add(pl.Set(t));
        return Seq(pl, t);
    }

    string IncDec(IIncrementOrDecrementOperation inc, bool stmt)
    {
        var up = inc.Kind == OperationKind.Increment;
        var post = inc.IsPostfix;
        var tt = inc.Target.Type!;
        var pl = PlaceOf(inc.Target, true);
        Func<string, string> step;
        if (inc.OperatorMethod != null)
        {
            var m = up ? "op_Increment" : "op_Decrement";
            var cls0 = RuntimeClass((INamedTypeSymbol)tt);
            Use("operator " + inc.OperatorMethod.OriginalDefinition.ToDisplayString(), cls0 + "." + m);
            step = c => cls0 + "." + m + "(" + Strip(c) + ")";
        }
        else step = c => Step(c, tt, up);
        if (stmt) return Seq(pl, pl.Set(step(pl.Get)));
        if (!post)
        {
            if (pl.SetYields) return Seq(pl, pl.Set(step(pl.Get)));
            var t0 = Temp();
            pl.Setup.Add(t0 + " = " + Strip(step(pl.Get)));
            pl.Setup.Add(pl.Set(t0));
            return Seq(pl, t0);
        }
        var t = Temp();
        pl.Setup.Add(t + " = " + Strip(pl.Get));
        pl.Setup.Add(pl.Set(step(t)));
        return Seq(pl, t);
    }

    /// <summary>c + 1 or c - 1 in the type of c, wrapped as C# wraps it.</summary>
    string Step(string c, ITypeSymbol t, bool up)
    {
        var u = Under(t);
        var op = up ? " + 1" : " - 1";
        switch (u.SpecialType)
        {
            case SpecialType.System_Int32: return "((" + c + op + ") | 0)";
            case SpecialType.System_UInt32: return "((" + c + op + ") >>> 0)";
            case SpecialType.System_Int64: return L(up ? "incL" : "decL") + "(" + Strip(c) + ")";
            case SpecialType.System_UInt64: return L(up ? "incUL" : "decUL") + "(" + Strip(c) + ")";
            case SpecialType.System_Int16: return "(((" + c + op + ") << 16) >> 16)";
            case SpecialType.System_UInt16: case SpecialType.System_Char: return "((" + c + op + ") & 0xFFFF)";
            case SpecialType.System_SByte: return "(((" + c + op + ") << 24) >> 24)";
            case SpecialType.System_Byte: return "((" + c + op + ") & 0xFF)";
            case SpecialType.System_Double: return "(" + c + op + ")";
            case SpecialType.System_Single: return "Math.fround(" + c + op + ")";
        }
        return Todo("++ or -- on " + t.ToDisplayString());
    }

    // -------------------------------------------------------------------------------------------- references
    /// <summary>A Ref object for the location op names (a ref argument, a ref local, a ref return).</summary>
    public string RefOf(IOperation op)
    {
        switch (op)
        {
            case ILocalReferenceOperation l:
                if (l.Local.RefKind != RefKind.None || Boxed(l.Local)) return Name(l.Local);
                return Todo("reference to a local that is not a cell: " + l.Local.Name);
            case IParameterReferenceOperation p:
                if (p.Parameter.RefKind is RefKind.Ref or RefKind.Out or RefKind.In || Boxed(p.Parameter)) return Name(p.Parameter);
                return Todo("reference to a parameter that is not a cell: " + p.Parameter.Name);
            case IFieldReferenceOperation f:
                {
                    var fs = f.Field;
                    var fr = H("cpp.fieldRef", "fieldRef(obj, name): a Ref to the property name of obj (an object, or a class for a static field)");
                    if (fs.IsStatic) return fr + "(" + StaticFieldOwner(fs) + ", \"" + FieldName(fs) + "\")";
                    return fr + "(" + Strip(X(f.Instance!)) + ", \"" + FieldName(fs) + "\")";
                }
            case IArrayElementReferenceOperation ae:
                return "new " + H("cpp.ArrRef", "new ArrRef(array, index): a Ref to array[index]") + "(" + Strip(X(ae.ArrayReference)) + ", " + Strip(Index(ae.Indices[0])) + ")";
            case IPropertyReferenceOperation pr:
                {
                    if (VecElem(pr, out var recv, out var field, out var idx))
                        return "new " + H("cpp.ArrRef", "new ArrRef(array, index): a Ref to array[index]") + "(" + recv + "." + field + ", " + Strip(idx) + ")";
                    if (IsCPtrIndexer(pr)) { UseCPtr(); return Recv(pr.Instance!) + ".ref(" + Strip(Index(pr.Arguments[0].Value)) + ")"; }
                    if (pr.Property.RefKind != RefKind.None) return Prop(pr, true);
                    return Todo("reference to a property that returns no reference: " + pr.Property.Name);
                }
            case IInvocationOperation inv when inv.TargetMethod.RefKind != RefKind.None:
                return Invoke(inv, true);
            case IConditionalOperation c when c.IsRef:
                return "(" + X(c.Condition) + " ? " + Strip(RefOf(c.WhenTrue)) + " : " + Strip(RefOf(c.WhenFalse!)) + ")";
            case IDeclarationExpressionOperation de when de.Expression is ILocalReferenceOperation dl:
                {
                    // out var x: x is a cell, declared before the statement
                    var n = Declare(dl.Local, dl.Local.Name);
                    pendingDecls.Add("let " + n + " = " + NewCell(dl.Local.Type) + "(" + DefaultOf(dl.Local.Type) + ");");
                    return n;
                }
            case IDiscardOperation d:
                // out _: a cell nobody reads
                return NewCell(d.Type!) + "(" + DefaultOf(d.Type!) + ")";
            case IConversionOperation cv when cv.Conversion.IsIdentity:
                return RefOf(cv.Operand);
        }
        return Todo("reference to " + op.Kind);
    }

    // -------------------------------------------------------------------------------------------- expressions
    /// <summary>The value of op, converted (as C# does at this point) to target if given.</summary>
    public string Value(IOperation op, ITypeSymbol? target)
    {
        var s = X(op);
        if (target != null && op.Type != null && !SymbolEqualityComparer.Default.Equals(op.Type, target))
            s = Conv(s, op.Type, target);
        return s;
    }

    public string X(IOperation op)
    {
        if (op.ConstantValue.HasValue) return Const(op.ConstantValue.Value, op.Type);
        switch (op)
        {
            case IConversionOperation c: return Conversion(c);
            case ILocalReferenceOperation l: return Read(l.Local);
            case IParameterReferenceOperation pr:
                {
                    var n = Name(pr.Parameter);
                    if (pr.Parameter.RefKind is RefKind.Ref or RefKind.Out or RefKind.In) return n + ".get()";
                    return Boxed(pr.Parameter) ? n + ".v" : n;
                }
            case IInstanceReferenceOperation ir:
                if (ir.ReferenceKind == InstanceReferenceKind.ImplicitReceiver) return implicitRecv.Count > 0 ? implicitRecv.Peek() : Todo("implicit receiver");
                return "this";
            case IFieldReferenceOperation f: return Field(f);
            case IPropertyReferenceOperation p: return Prop(p, false);
            case IArrayElementReferenceOperation ae: return Recv(ae.ArrayReference) + "[" + Strip(Index(ae.Indices[0])) + "]";
            case IInvocationOperation inv: return Invoke(inv, false);
            case IObjectCreationOperation oc: return New(oc);
            case IArrayCreationOperation ac: return NewArray(ac);
            case IBinaryOperation b: return Binary(b);
            case IUnaryOperation u: return Unary(u);
            case IConditionalOperation c: return Ternary(c);
            case ISimpleAssignmentOperation a: return AssignExpr(a);
            case ICompoundAssignmentOperation ca: return Compound(ca, false);
            case IIncrementOrDecrementOperation inc: return IncDec(inc, false);
            case IConditionalAccessOperation ca: return CondAccess(ca);
            case IConditionalAccessInstanceOperation: return condAccess.Count > 0 ? condAccess.Peek() : Todo("conditional access instance");
            case IAnonymousFunctionOperation af: return Lambda(af, null);
            case IDelegateCreationOperation dc: return DelegateCreation(dc);
            case IDefaultValueOperation dv: return DefaultOf(dv.Type!);
            case ILiteralOperation lit: return Const(lit.ConstantValue.Value, lit.Type);
            case IIsTypeOperation it: return "(" + Recv(it.ValueOperand) + " instanceof " + ClassRef(it.TypeOperand) + ")";
            case IThrowOperation th:
                return H("cpp.R.thr", "thr(e): throws e (a throw expression); never returns") + "(" + Strip(X(th.Exception!)) + ")";
            case IParenthesizedOperation pp: return X(pp.Operand);
            case ICoalesceOperation co: return "(" + X(co.Value) + " ?? " + Value(co.WhenNull, co.Type) + ")";
            case IDiscardOperation: return Todo("discard as a value");
        }
        return Todo("expression " + op.Kind);
    }

    /// <summary>The class an instanceof (or as) tests against.</summary>
    static string ClassRef(ITypeSymbol t)
    {
        if (t is INamedTypeSymbol n && IsEngine(n) && n.TypeKind == TypeKind.Class) return TypeIdent(n);
        if (t is INamedTypeSymbol r && IsRuntime(r) && r.TypeKind == TypeKind.Class) { Use("instanceof " + r.OriginalDefinition.ToDisplayString(), RuntimeClass(r)); return RuntimeClass(r); }
        return Todo("type test against " + t.ToDisplayString());
    }

    /// <summary>An array index: a number (a long index through cpp.L.ix).</summary>
    string Index(IOperation i)
    {
        var t = i.Type;
        // an int or uint widened to a 64-bit index ((ulong)i): the int itself (a negative one reads undefined either way)
        if (i is IConversionOperation cv && cv.OperatorMethod == null && cv.Operand.Type != null && IsLong(t) && IsIntegral(Under(cv.Operand.Type)) && !IsLong(cv.Operand.Type))
            return X(cv.Operand);
        var s = X(i);
        if (t != null && IsLong(t)) return L("ix") + "(" + Strip(s) + ")";
        return s;
    }

    static string Paren(string s) => Simple(s) || s.StartsWith("(") && s.EndsWith(")") && Balanced(s, 1, s.Length - 1) ? s : "(" + s + ")";

    /// <summary>A cpp.L helper (64-bit integer arithmetic): recorded in the manifest.</summary>
    static string L(string name)
    {
        var full = "cpp.L." + name;
        Use("helper " + full, full + "  -- see RUNTIME_HELPERS.md");
        return full;
    }

    // ---- constants
    public static string Const(object? v, ITypeSymbol? t)
    {
        if (v == null) return t != null && t.IsValueType && !(t is INamedTypeSymbol nn && nn.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T) ? DefaultOf(t) : "null";
        if (t != null && t.TypeKind == TypeKind.Enum) t = Under(t);
        switch (v)
        {
            case bool b: return b ? "true" : "false";
            case string s: return JStr(s);
            case char ch: return ((int)ch).ToString(CultureInfo.InvariantCulture);
            case double d: return t != null && t.SpecialType == SpecialType.System_Single ? FloatLit((float)d) : DoubleLit(d);
            case float f: return t != null && t.SpecialType == SpecialType.System_Double ? DoubleLit(f) : FloatLit(f);
        }
        // integers: the value the target type holds (a long or ulong beyond 2^53 as a bigint)
        var st = t?.SpecialType ?? SpecialType.System_Int32;
        System.Numerics.BigInteger val = v switch
        {
            int i => i, long l => l, uint u => u, ulong ul => ul, short sh => sh, ushort us => us, byte by => by, sbyte sb => sb, _ => 0
        };
        System.Numerics.BigInteger lo, hi;
        switch (st)
        {
            case SpecialType.System_Int64: lo = long.MinValue; hi = long.MaxValue; break;
            case SpecialType.System_UInt64: lo = 0; hi = ulong.MaxValue; break;
            case SpecialType.System_UInt32: lo = 0; hi = uint.MaxValue; break;
            case SpecialType.System_Int16: lo = short.MinValue; hi = short.MaxValue; break;
            case SpecialType.System_UInt16: case SpecialType.System_Char: lo = 0; hi = ushort.MaxValue; break;
            case SpecialType.System_SByte: lo = sbyte.MinValue; hi = sbyte.MaxValue; break;
            case SpecialType.System_Byte: lo = 0; hi = byte.MaxValue; break;
            case SpecialType.System_Double: return DoubleLit((double)val);
            case SpecialType.System_Single: return FloatLit((float)val);
            default: lo = int.MinValue; hi = int.MaxValue; break;
        }
        if (val < lo || val > hi)
        {
            // the bit pattern in the target type (an unchecked constant conversion has already been folded by Roslyn)
            var bits = hi - lo + 1;
            val = ((val - lo) % bits + bits) % bits + lo;
        }
        var safe = System.Numerics.BigInteger.Abs(val) <= 9007199254740991;
        var text = val.ToString(CultureInfo.InvariantCulture) + (safe ? "" : "n");
        return val < 0 ? "(" + text + ")" : text;
    }

    static string DoubleLit(double d)
    {
        if (double.IsNaN(d))
        {
            var bits = (ulong)BitConverter.DoubleToInt64Bits(d);
            var hn = H("cpp.R.f64bits", "f64bits(hi, lo): the double whose bits are hi:lo (two uint32s); used for NaNs, whose sign and payload C# keeps");
            return ModuleConst("nan", hn + "(0x" + (bits >> 32).ToString("x8") + ", 0x" + (bits & 0xFFFFFFFF).ToString("x8") + ")");
        }
        if (double.IsPositiveInfinity(d)) return "Infinity";
        if (double.IsNegativeInfinity(d)) return "(-Infinity)";
        if (d == 0 && double.IsNegative(d)) return "(-0)";
        var s = d.ToString("R", CultureInfo.InvariantCulture);
        if (s.Contains("E")) s = s.Replace("E", "e");
        return d < 0 ? "(" + s + ")" : s;
    }

    /// <summary>A float constant: the double that equals it exactly (Math.fround of it is itself).</summary>
    static string FloatLit(float f)
    {
        if (float.IsNaN(f))
        {
            var hn = H("cpp.R.f32bits", "f32bits(bits): the float (as a number) whose bits are the uint32 bits");
            return ModuleConst("nanf", hn + "(0x" + ((uint)BitConverter.SingleToInt32Bits(f)).ToString("x8") + ")");
        }
        return DoubleLit((double)f);
    }

    public static string JStr(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (var ch in s)
        {
            int c = ch;
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c >= 32 && c < 127) sb.Append(ch);
            else sb.Append("\\u").Append(c.ToString("x4"));
        }
        return sb.Append('"').ToString();
    }

    // ---- conversions
    string Conversion(IConversionOperation c)
    {
        var from = c.Operand.Type;
        var to = c.Type!;
        if (c.OperatorMethod != null) return RuntimeConvOp(c.OperatorMethod, c.Operand);
        if (c.Operand is IAnonymousFunctionOperation af) return Lambda(af, to);
        if (c.Operand is IDelegateCreationOperation dc0 && to.TypeKind == TypeKind.Delegate) return DelegateCreation(dc0);
        if (from == null)
        {
            if (c.Operand is ILiteralOperation || c.Operand is IDefaultValueOperation) return DefaultOf(to);
            return X(c.Operand);
        }
        if (c.IsTryCast)
        {
            var t = Temp();
            return "((" + t + " = " + Strip(X(c.Operand)) + ") instanceof " + ClassRef(to) + " ? " + t + " : null)";
        }
        if (c.IsChecked && IsNumeric(Under(from)) && IsNumeric(Under(to))) Todo0("checked numeric conversion (translated unchecked)");
        // (C)(B)a with a an integer of 32 bits or fewer, B a 64-bit integer and C an integer: B holds a's sign- or
        // zero-extension whole, so the result is (C)a (int i: (long)(ulong)i is i, not toI64(toU64(i)))
        if (c.Operand is IConversionOperation inner && inner.OperatorMethod == null && inner.Operand.Type != null && !inner.IsChecked
            && IsIntegral(Under(to)) && IsLong(from) && IsIntegral(Under(inner.Operand.Type)) && !IsLong(inner.Operand.Type))
            return Conv(X(inner.Operand), inner.Operand.Type, to);
        return Conv(X(c.Operand), from, to);
    }

    /// <summary>s, of C# type from, as a value of C# type to (C#'s unchecked conversions).</summary>
    public string Conv(string s, ITypeSymbol from, ITypeSymbol to)
    {
        if (SymbolEqualityComparer.Default.Equals(from, to)) return s;
        var f = Under(from); var t = Under(to);
        if (SymbolEqualityComparer.Default.Equals(f, t)) return s;
        if (IsNumeric(t) && IsNumeric(f)) return NumConv(s, f.SpecialType, t.SpecialType);
        if (t.SpecialType == SpecialType.System_Boolean && f.SpecialType == SpecialType.System_Boolean) return s;
        // boxing and unboxing: the value itself
        if (to.SpecialType == SpecialType.System_Object || to.TypeKind == TypeKind.Interface) return s;
        if (from.SpecialType == SpecialType.System_Object || from.TypeKind == TypeKind.Interface || from is ITypeParameterSymbol)
            return PrimitiveLike(to) ? s : Paren(s);     // TypeScript: (s as T), which checks nothing at run time
        if (to is INamedTypeSymbol tex && IsSystem(tex) && tex.Name == "Exception") return s;
        if (from is INamedTypeSymbol fn && to is INamedTypeSymbol tn && (IsEngine(fn) || IsRuntime(fn)) && (IsEngine(tn) || IsRuntime(tn)))
        {
            if (Derives(fn, tn) || tn.TypeKind == TypeKind.Interface) return s;
            if (Derives(tn, fn)) return Paren(s);
        }
        if (from is INamedTypeSymbol fe && IsSystem(fe) && fe.Name == "Exception" && to is INamedTypeSymbol te2 && (IsEngine(te2) || IsRuntime(te2))) return Paren(s);
        if (from.TypeKind == TypeKind.Delegate && to.TypeKind == TypeKind.Delegate) return s;
        if (to is INamedTypeSymbol nl && nl.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            return IsNumeric(Under(nl.TypeArguments[0])) && IsNumeric(f) ? Conv(s, from, nl.TypeArguments[0]) : s;
        if (from is INamedTypeSymbol nf && nf.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            return IsNumeric(Under(nf.TypeArguments[0])) && IsNumeric(t) ? Conv(s, nf.TypeArguments[0], to) : s;
        if (SymbolEqualityComparer.Default.Equals(from.OriginalDefinition, to.OriginalDefinition)) return s;
        if (from.TypeKind == TypeKind.Array && to.TypeKind == TypeKind.Array) return s;
        if (from.SpecialType == SpecialType.System_String && to.SpecialType == SpecialType.System_String) return s;
        return Todo("conversion " + from.ToDisplayString() + " -> " + to.ToDisplayString());
    }

    static bool PrimitiveLike(ITypeSymbol t) => IsNumeric(Under(t)) || t.SpecialType is SpecialType.System_Boolean or SpecialType.System_String;

    /// <summary>A numeric conversion with C#'s unchecked semantics; double to integer through the runtime's
    /// x86 cvttsd2si helpers (Conv.D2I, ...), as the C# runtime has them.</summary>
    static string NumConv(string s, SpecialType f, SpecialType t)
    {
        bool fl = f is SpecialType.System_Double or SpecialType.System_Single;
        bool f64 = f is SpecialType.System_Int64 or SpecialType.System_UInt64;
        if (t == SpecialType.System_Double)
        {
            if (f64) return L("toF64") + "(" + Strip(s) + ")";
            return s;
        }
        if (t == SpecialType.System_Single)
        {
            if (f64) return L("toF32") + "(" + Strip(s) + ")";
            if (f == SpecialType.System_Double || f is SpecialType.System_Int32 or SpecialType.System_UInt32) return "Math.fround(" + Strip(s) + ")";
            return s;      // a 16- or 8-bit integer is a float exactly
        }
        if (fl)
        {
            var k = t switch
            {
                SpecialType.System_Int32 => "D2I", SpecialType.System_UInt32 => "D2U", SpecialType.System_Int64 => "D2L", SpecialType.System_UInt64 => "D2UL",
                SpecialType.System_Int16 => "D2S", SpecialType.System_UInt16 => "D2US", SpecialType.System_SByte => "D2SB", SpecialType.System_Byte => "D2B",
                SpecialType.System_Char => "D2US", _ => "D2I"
            };
            Use("static Cpp.Conv." + k + "(double)", "cpp.Conv." + k);
            return "cpp.Conv." + k + "(" + Strip(s) + ")";
        }
        // integer to integer
        string i32() => f64 ? L("toI32") + "(" + Strip(s) + ")" : s;    // the low 32 bits as an int-like number
        switch (t)
        {
            case SpecialType.System_Int32:
                if (f64) return L("toI32") + "(" + Strip(s) + ")";
                if (f == SpecialType.System_UInt32) return "(" + s + " | 0)";
                return s;
            case SpecialType.System_UInt32:
                if (f64) return L("toU32") + "(" + Strip(s) + ")";
                if (f is SpecialType.System_Int32 or SpecialType.System_Int16 or SpecialType.System_SByte) return "(" + s + " >>> 0)";
                return s;
            case SpecialType.System_Int64:
                if (f == SpecialType.System_UInt64) return L("toI64") + "(" + Strip(s) + ")";
                return s;
            case SpecialType.System_UInt64:
                if (f is SpecialType.System_Int64 or SpecialType.System_Int32 or SpecialType.System_Int16 or SpecialType.System_SByte) return L("toU64") + "(" + Strip(s) + ")";
                return s;
            case SpecialType.System_Int16:
                if (f is SpecialType.System_SByte or SpecialType.System_Byte) return s;
                return "((" + i32() + " << 16) >> 16)";
            case SpecialType.System_UInt16:
            case SpecialType.System_Char:
                if (f is SpecialType.System_Byte or SpecialType.System_UInt16 or SpecialType.System_Char) return s;
                return "(" + i32() + " & 0xFFFF)";
            case SpecialType.System_SByte:
                return "((" + i32() + " << 24) >> 24)";
            case SpecialType.System_Byte:
                return "(" + i32() + " & 0xFF)";
        }
        return Todo("numeric conversion " + f + " -> " + t);
    }

    string RuntimeConvOp(IMethodSymbol op, IOperation operand)
    {
        var t = op.ContainingType;
        if (!IsRuntime(op)) return Todo("engine conversion operator");
        var nm = RuntimeClass(t) + ".from_" + ShortType(op.OriginalDefinition.Parameters[0].Type);
        Use("conversion " + op.OriginalDefinition.ToDisplayString(), nm);
        return nm + "(" + Strip(Value(operand, op.Parameters[0].Type)) + ")";
    }

    // ---- fields and properties
    static string FieldName(IFieldSymbol fs) => IsRuntime(fs) ? fs.Name : FieldIdent(fs);

    static string StaticFieldOwner(IFieldSymbol fs) => IsRuntime(fs) ? RuntimeClass(fs.ContainingType) : TypeIdent(fs.ContainingType);

    string Field(IFieldReferenceOperation f)
    {
        var fs = f.Field;
        if (fs.ContainingType.TypeKind == TypeKind.Enum) return Const(fs.ConstantValue, fs.Type);
        if (IsRuntime(fs))
        {
            if (fs.IsStatic || fs.IsConst)
            {
                var n = RuntimeClass(fs.ContainingType) + "." + fs.Name;
                Use("static field " + fs.OriginalDefinition.ToDisplayString(), n);
                return n;
            }
            Use("field " + fs.OriginalDefinition.ToDisplayString(), fs.Name);
            return Recv(f.Instance!) + "." + fs.Name;
        }
        if (fs.IsStatic || fs.IsConst) return TypeIdent(fs.ContainingType) + "." + FieldIdent(fs);
        return Recv(f.Instance!) + "." + FieldIdent(fs);
    }

    string Recv(IOperation inst)
    {
        var s = X(inst);
        return Simple(s) ? s : "(" + Strip(s) + ")";
    }

    /// <summary>s can be followed by .member or [index] as it is.</summary>
    static bool Simple(string s)
    {
        if (s.Length == 0 || char.IsDigit(s[0]) || s[0] == '-') return false;
        int depth = 0;
        for (int i = 0; i < s.Length; i++)
        {
            var ch = s[i];
            if (ch == '"') { if (depth == 0) return false; i = SkipStr(s, i); continue; }
            if (ch == '(' || ch == '[') depth++;
            else if (ch == ')' || ch == ']') depth--;
            else if (depth == 0 && !(char.IsLetterOrDigit(ch) || ch == '_' || ch == '$' || ch == '.')) return false;
        }
        return depth == 0;
    }

    static bool IsCPtrIndexer(IPropertyReferenceOperation p) => p.Property.IsIndexer && p.Property.ContainingType.Name == "CPtr" && IsRuntime(p.Property);

    static void UseCPtr() => Use("CPtr indexer (an sbyte value)", "get(i), set(i, v), ref(i)");

    /// <summary>A vector or string element: the receiver, its backing array's field and the index.</summary>
    bool VecElem(IPropertyReferenceOperation p, out string recv, out string field, out string idx)
    {
        recv = field = idx = "";
        var tn = StripArity(p.Property.ContainingType.Name);
        if (!p.Property.IsIndexer || !IsRuntime(p.Property) || p.Property.RefKind == RefKind.None) return false;
        if (tn == "Vec") { recv = Recv(p.Instance!); field = "a"; idx = Index(p.Arguments[0].Value); Use("Vec.a (backing array, elements read and written directly)", "a"); return true; }
        if (tn == "Str") { recv = Recv(p.Instance!); field = "b"; idx = Index(p.Arguments[0].Value); Use("Str.b (backing byte array, elements read and written directly)", "b"); return true; }
        return false;
    }

    /// <summary>A runtime property or indexer: a vector or string element is its backing array; a ref one is
    /// get_X() for its value and ref_X() for a Ref; a plain one is get_X().</summary>
    string Prop(IPropertyReferenceOperation p, bool asRef)
    {
        var ps = p.Property;
        if (IsSystem(ps) && ps.Name == "Length") return Recv(p.Instance!) + ".length";
        if (!IsRuntime(ps)) return Todo((IsSystem(ps) ? "system" : "engine") + " property " + ps.ContainingType.Name + "." + ps.Name);
        if (!asRef && VecElem(p, out var recv, out var field, out var idx)) return recv + "." + field + "[" + Strip(idx) + "]";
        if (IsCPtrIndexer(p) && !asRef) { UseCPtr(); return Recv(p.Instance!) + ".get(" + Strip(Index(p.Arguments[0].Value)) + ")"; }
        var owner = ps.IsStatic ? RuntimeClass(ps.ContainingType) : Recv(p.Instance!);
        if (asRef)
        {
            var (nm, key) = PropName(ps);
            Use(key + " (ref)", "ref_" + nm);
            return owner + ".ref_" + nm + "(" + PropArgs(p) + ")";
        }
        return PropGet(p, owner);
    }

    static (string nm, string key) PropName(IPropertySymbol ps)
    {
        var nm = ps.IsIndexer ? "Item" : ps.Name;
        var sfx = ps.IsIndexer && ps.ContainingType.GetMembers().OfType<IPropertySymbol>().Count(x => x.IsIndexer) > 1 ? "_" + ShortType(ps.OriginalDefinition.Parameters[0].Type) : "";
        var key = (ps.IsStatic ? "static property " : "property ") + ps.ContainingType.OriginalDefinition.ToDisplayString() + "." + ps.Name + (ps.IsIndexer ? "[" + string.Join(",", ps.OriginalDefinition.Parameters.Select(x => x.Type.ToDisplayString())) + "]" : "");
        return (nm + sfx, key);
    }

    string PropArgs(IPropertyReferenceOperation p) => string.Join(", ", p.Arguments.Select(a => Strip(IsLong(a.Parameter!.Type) ? Value(a.Value, a.Parameter.Type) : Value(a.Value, a.Parameter.Type))));

    string PropGet(IPropertyReferenceOperation p, string owner)
    {
        var (nm, key) = PropName(p.Property);
        Use(key, "get_" + nm);
        return owner + ".get_" + nm + "(" + PropArgs(p) + ")";
    }

    string PropSet(IPropertyReferenceOperation p, string owner, string v)
    {
        var ps = p.Property;
        if (!IsRuntime(ps)) return Todo("set engine property " + ps.Name);
        Use("property set " + ps.ContainingType.OriginalDefinition.ToDisplayString() + "." + ps.Name, "set_" + ps.Name);
        return owner + ".set_" + ps.Name + "(" + Strip(v) + ")";
    }

    // ---- calls
    /// <summary>The arguments of a call, in parameter order. A params array is passed as separate arguments to a
    /// runtime member (a rest parameter) and as the array to an engine method.</summary>
    public string Args(IMethodSymbol m, IEnumerable<IArgumentOperation> args) => string.Join(", ", ArgList(m, args));

    public List<string> ArgList(IMethodSymbol m, IEnumerable<IArgumentOperation> args)
    {
        var outv = new List<string>();
        bool expand = IsRuntime(m) || IsSystem(m);
        foreach (var a in args.OrderBy(a => a.Parameter?.Ordinal ?? 0))
        {
            var prm = a.Parameter!;
            if (a.ArgumentKind == ArgumentKind.ParamArray && expand)
            {
                if (a.Value is IArrayCreationOperation ac && ac.Initializer != null)
                {
                    var et = ((IArrayTypeSymbol)prm.Type).ElementType;
                    foreach (var e in ac.Initializer.ElementValues) outv.Add(Strip(Value(e, et)));
                }
                else if (a.Value is IArrayCreationOperation ac0 && ac0.DimensionSizes.Length == 1 && ac0.DimensionSizes[0].ConstantValue.Value is 0) { }
                else outv.Add("..." + Paren(X(a.Value)));
                continue;
            }
            if (prm.RefKind is RefKind.Ref or RefKind.Out or RefKind.In) outv.Add(Strip(RefOf(a.Value)));
            else outv.Add(Strip(Value(a.Value, prm.Type)));
        }
        return outv;
    }

    string Invoke(IInvocationOperation inv, bool asRef)
    {
        var m = inv.TargetMethod;
        string call;
        if (m.MethodKind == MethodKind.DelegateInvoke)
        {
            call = Recv(inv.Instance!) + "(" + Args(m, inv.Arguments) + ")";
            if (m.RefKind != RefKind.None) return asRef ? call : call + ".get()";
            return call;
        }
        if (IsRuntime(m) || IsSystem(m)) return RuntimeCall(m, inv.Instance, inv.Arguments, asRef);
        if (m.IsGenericMethod) Todo0("call of a generic engine method " + m.Name);
        if (m.IsStatic) call = TypeIdent(m.ContainingType) + "." + MethodIdent(m) + "(" + Args(m, inv.Arguments) + ")";
        else
        {
            var mn = MethodIdent(m);
            var isThis = inv.Instance is IInstanceReferenceOperation ir && ir.ReferenceKind == InstanceReferenceKind.ContainingTypeInstance;
            if (isThis && !inv.IsVirtual && (m.IsVirtual || m.IsOverride || m.IsAbstract) && !SymbolEqualityComparer.Default.Equals(m.ContainingType.OriginalDefinition, cls.OriginalDefinition))
                call = "super." + mn + "(" + Args(m, inv.Arguments) + ")";
            else if (!inv.IsVirtual && !(m.IsVirtual || m.IsOverride || m.IsAbstract) && HiddenBelow(m))
            {
                // a non-virtual method that a class derived from the receiver's type declares again under the same
                // JavaScript name (a method the runtime calls by name, such as Clone): bind it as C# does
                Note("non-virtual call bound to its class (a derived class has a method of the same name): " + m.Name);
                call = TypeIdent(m.ContainingType) + ".prototype." + mn + ".call(" + Strip(X(inv.Instance!)) + (inv.Arguments.Length > 0 ? ", " + Args(m, inv.Arguments) : "") + ")";
            }
            else call = Recv(inv.Instance!) + "." + mn + "(" + Args(m, inv.Arguments) + ")";
        }
        if (m.RefKind != RefKind.None) return asRef ? call : call + ".get()";
        return call;
    }

    /// <summary>A class derived from m's class has an instance method with m's JavaScript name that does not override it.</summary>
    static bool HiddenBelow(IMethodSymbol m)
    {
        var nm = MethodIdent(m);
        foreach (var d in Descendants(m.ContainingType))
            foreach (var x in d.GetMembers().OfType<IMethodSymbol>())
                if (!x.IsStatic && x.MethodKind == MethodKind.Ordinary && !IsOverrideOf(x, m) && !SymbolEqualityComparer.Default.Equals(x.OriginalDefinition, m.OriginalDefinition) && MethodIdent(x) == nm) return true;
        return false;
    }

    /// <summary>A runtime member's JavaScript name (the TypeScript translator's): its C# name, with the Go translator's parameter-type suffix
    /// when the class has several members of that name, then (for a type-dependent member) the type arguments'
    /// codes.</summary>
    static string RuntimeName(IMethodSymbol m)
    {
        var t = m.ContainingType;
        var overloads = t.GetMembers(m.Name).OfType<IMethodSymbol>().Count();
        var sfx = overloads > 1 ? "_" + string.Join("_", m.OriginalDefinition.Parameters.Select(p => ShortType(p.Type) + (p.RefKind != RefKind.None ? "r" : ""))) : "";
        return m.Name + sfx + Spec(m);
    }

    /// <summary>The runtime members that make a T for themselves (C#'s Elem&lt;T&gt;.Make or new T()): they get a maker
    /// for each such type argument as extra last arguments.</summary>
    static List<ITypeSymbol> MakerTypes(IMethodSymbol m)
    {
        var res = new List<ITypeSymbol>();
        var t = StripArity(m.ContainingType.Name);
        var od = m.OriginalDefinition;
        if (t == "Mv" && m.Name == "Take" || t == "Arr" && (m.Name == "Make" && m.Parameters.Length == 1 || m.Name == "Make2") || t == "R" && m.Name == "Realloc")
            res.Add(m.TypeArguments[0]);
        else
            for (int i = 0; i < od.TypeParameters.Length; i++)
                if (od.TypeParameters[i].HasConstructorConstraint) res.Add(m.TypeArguments[i]);
        return res;
    }

    string RuntimeCall(IMethodSymbol m, IOperation? inst, System.Collections.Immutable.ImmutableArray<IArgumentOperation> argOps, bool asRef)
    {
        var t = m.ContainingType;
        if (IsSystem(m)) return SystemCall(m, inst, argOps);
        var args = Args(m, argOps);
        if (m.Name == "ToString" && !m.IsStatic && m.Parameters.Length == 0) { Use("method " + m.OriginalDefinition.ToDisplayString(), "toString()"); return Recv(inst!) + ".toString()"; }
        var nm = RuntimeName(m);
        var refm = m.RefKind != RefKind.None;
        if (refm && asRef) nm = "ref_" + nm;
        var makers = MakerTypes(m);
        if (makers.Count > 0) args = string.Join(", ", (args.Length > 0 ? new[] { args } : new string[0]).Concat(makers.Select(Maker)));
        var key = (m.IsStatic ? "static " : "method ") + m.OriginalDefinition.ToDisplayString() + (Spec(m).Length > 0 ? " " + Spec(m) : "") + (refm && asRef ? " (ref)" : "") + (makers.Count > 0 ? " + makers" : "");
        if (m.IsStatic)
        {
            var cn = RuntimeClass(t);
            Use(key, cn + "." + nm);
            return cn + "." + nm + "(" + args + ")";
        }
        Use(key, nm);
        return Recv(inst!) + "." + nm + "(" + args + ")";
    }

    string SystemCall(IMethodSymbol m, IOperation? inst, System.Collections.Immutable.ImmutableArray<IArgumentOperation> argOps)
    {
        var t = m.ContainingType.Name;
        var a = ArgList(m, argOps);
        var args = string.Join(", ", a);
        var p0 = m.Parameters.Length > 0 ? m.Parameters[0].Type.SpecialType : SpecialType.None;
        if (t == "Math" || t == "MathF")
        {
            // exact in JavaScript as in .NET: sqrt, abs, floor, ceil, trunc; max and min of doubles (NaN and the signed
            // zeros as .NET Core has them) and of ints
            bool dbl = p0 == SpecialType.System_Double, flt = p0 == SpecialType.System_Single, i32 = p0 == SpecialType.System_Int32;
            switch (m.Name)
            {
                case "Sqrt" when dbl: return "Math.sqrt(" + args + ")";
                case "Sqrt" when flt: return "Math.fround(Math.sqrt(" + args + "))";
                case "Abs" when dbl || flt: return "Math.abs(" + args + ")";
                case "Floor" when dbl || flt: return "Math.floor(" + args + ")";
                case "Ceiling" when dbl || flt: return "Math.ceil(" + args + ")";
                case "Truncate" when dbl: return "Math.trunc(" + args + ")";
                case "Max" when dbl || i32: return "Math.max(" + args + ")";
                case "Min" when dbl || i32: return "Math.min(" + args + ")";
            }
            var n = "cpp.SysMath." + m.Name + "_" + string.Join("_", m.Parameters.Select(p => ShortType(p.Type)));
            Use("System." + t + "." + m.Name + "(" + string.Join(",", m.Parameters.Select(p => p.Type.Name)) + ")", n);
            return n + "(" + args + ")";
        }
        if (t == "Object" && m.Name == "ReferenceEquals") return "(" + a[0] + " === " + a[1] + ")";
        if (t == "Double" || t == "Single")
        {
            switch (m.Name)
            {
                case "IsFinite": return "Number.isFinite(" + args + ")";
                case "IsNaN": return "Number.isNaN(" + args + ")";
                case "IsInfinity": return H("cpp.R.isInf", "isInf(x): x is +Infinity or -Infinity") + "(" + args + ")";
                case "IsPositiveInfinity": return "(" + Paren(args) + " === Infinity)";
                case "IsNegativeInfinity": return "(" + Paren(args) + " === -Infinity)";
                case "IsNegative": return H("cpp.R.signbit", "signbit(x): the sign bit of the double x (true for -0 and negative NaNs)") + "(" + args + ")";
            }
        }
        if (t == "BitConverter") { var n = "cpp.BitConverter." + m.Name; Use("System.BitConverter." + m.Name + "(" + string.Join(",", m.Parameters.Select(p => p.Type.Name)) + ")", n); return n + "(" + args + ")"; }
        if (t == "Array" && m.Name == "Fill" && m.Parameters.Length == 2) return Paren(a[0]) + ".fill(" + a[1] + ")";
        if (t == "File" && m.Name == "Exists") return H("cpp.R.File_Exists", "File_Exists(path: string): whether the file exists (System.IO.File.Exists)") + "(" + args + ")";
        if (m.Name == "Dispose" && inst != null) return Recv(inst) + ".Dispose()";
        if (m.Name == "GetHashCode" && inst != null) return H("cpp.R.hashCode", "hashCode(o): System.Object.GetHashCode of o (its own GetHashCode if it has one)") + "(" + Strip(X(inst)) + ")";
        if (m.Name == "Equals" && inst != null) return H("cpp.R.equals", "equals(a, b): System.Object.Equals(a, b) (a's own Equals if it has one)") + "(" + Strip(X(inst)) + ", " + args + ")";
        if (m.Name == "ToString" && inst != null && inst.Type?.SpecialType == SpecialType.System_String) return X(inst);
        if (m.Name == "ToString" && inst != null) return H("cpp.R.toStr", "toStr(x): x.ToString() as .NET writes it") + "(" + Strip(X(inst)) + ")";
        return Todo("system call " + m.ContainingType.ToDisplayString() + "." + m.Name);
    }

    string New(IObjectCreationOperation oc)
    {
        var t = (INamedTypeSymbol)oc.Type!;
        var c = oc.Constructor!;
        string e;
        if (t.TypeKind == TypeKind.Delegate) return Todo("delegate construction");
        if (IsEngine(t))
            e = "new " + TypeIdent(t) + "(" + Args(c, oc.Arguments) + ")";
        else if (IsRuntime(t))
        {
            var (args, appended) = MakerArgs(c, oc.Arguments, t);
            e = NewRuntime(t, c, args, appended);
        }
        else if (IsSystem(t))
        {
            if (t.Name.EndsWith("Exception"))
            {
                var se = H("cpp.SysException", "new SysException(kind: string, message: string): a .NET exception the C# throws itself (NotImplementedException, ...); only catch-all clauses take it");
                e = "new " + se + "(\"" + t.Name + "\", " + (oc.Arguments.Length > 0 ? Strip(X(oc.Arguments[0].Value)) : "\"\"") + ")";
            }
            else return Todo("new " + t.ToDisplayString());
        }
        else return Todo("new " + t.ToDisplayString());
        if (oc.Initializer == null || oc.Initializer.Initializers.Length == 0) return e;
        // new X() { a = 1, b = 2 }: one comma expression, the members set in order after the constructor
        var o = Temp();
        var parts = new List<string> { o + " = " + Strip(e) };
        implicitRecv.Push(o);
        foreach (var init in oc.Initializer.Initializers)
        {
            var st = StmtExpr(init);
            if (st.Length > 0) parts.Add(st);
        }
        implicitRecv.Pop();
        parts.Add(o);
        return "(" + string.Join(", ", parts) + ")";
    }

    /// <summary>An object of runtime class t made by its constructor c: new cpp.T(args) when the class has one
    /// constructor or c has no parameters, otherwise the static factory cpp.T.new_&lt;parameter codes&gt;(args)
    /// (JavaScript has one constructor per class; the factories are the Go translator's NewT_sfx).</summary>
    static string NewRuntime(INamedTypeSymbol t, IMethodSymbol c, string args, bool appended)
    {
        var nctors = t.InstanceConstructors.Count(k => !(k.IsImplicitlyDeclared && k.Parameters.Length == 0 && t.IsValueType));
        if (nctors <= 1 || c.Parameters.Length == 0)
        {
            Use("new " + c.OriginalDefinition.ToDisplayString() + (appended ? " + makers" : ""), "new " + RuntimeClass(t) + "(...)");
            return "new " + RuntimeClass(t) + "(" + args + ")";
        }
        var fname = "new_" + string.Join("_", c.OriginalDefinition.Parameters.Select(p => ShortType(p.Type) + (p.RefKind != RefKind.None ? "r" : "")));
        Use("new " + c.OriginalDefinition.ToDisplayString() + (appended ? " + makers" : ""), RuntimeClass(t) + "." + fname + "(...)  (a static factory: the class has several constructors)");
        return RuntimeClass(t) + "." + fname + "(" + args + ")";
    }

    // ---- element makers
    // C# makes a container's elements with reflection (Elem<T>.Make: the type's parameterless constructor, or
    // default(T)); JavaScript has no type arguments to ask, so a generic runtime class or method that makes a T itself is
    // handed a maker, () => T: Vec<T> (T), Map/UMap/UMapC<K, V> (V), Atomic<T> and Opt<T> (T) on every constructor, as
    // an extra last argument or in place of a null Func<T> mk parameter; Pair() and Tup() one per type argument;
    // UMapC/USetC the hasher and key-equal (new H(), new E()) after those.
    static readonly Dictionary<string, int[]> makerSlots = new() { ["Vec"] = new[] { 0 }, ["Map"] = new[] { 1 }, ["UMap"] = new[] { 1 }, ["UMapC"] = new[] { 1 }, ["Atomic"] = new[] { 0 }, ["Opt"] = new[] { 0 } };

    (string text, bool appended) MakerArgs(IMethodSymbol c, System.Collections.Immutable.ImmutableArray<IArgumentOperation> argOps, INamedTypeSymbol t)
    {
        var name = StripArity(t.Name);
        var outv = new List<string>();
        bool hasFunc = false;
        foreach (var a in argOps.OrderBy(a => a.Parameter?.Ordinal ?? 0))
        {
            var prm = a.Parameter!;
            if (prm.Type is INamedTypeSymbol ft && IsSystem(ft) && ft.Name == "Func" && ft.TypeArguments.Length == 1 && makerSlots.ContainsKey(name))
            {
                hasFunc = true;
                if (a.Value.ConstantValue is { HasValue: true, Value: null } || a.Value is IDefaultValueOperation || a.ArgumentKind == ArgumentKind.DefaultValue && a.Value.ConstantValue.HasValue)
                { outv.Add(Maker(ft.TypeArguments[0])); continue; }
            }
            if (a.ArgumentKind == ArgumentKind.ParamArray) { outv.Add(X(a.Value)); continue; }
            outv.Add(prm.RefKind is RefKind.Ref or RefKind.Out ? Strip(RefOf(a.Value)) : Strip(Value(a.Value, prm.Type)));
        }
        bool appended = false;
        if (!hasFunc)
        {
            if (makerSlots.TryGetValue(name, out var slots))
                foreach (var k in slots) { outv.Add(Maker(t.TypeArguments[k])); appended = true; }
            else if ((name == "Pair" || name == "Tup") && c.Parameters.Length == 0)
                foreach (var ta in t.TypeArguments) { outv.Add(Maker(ta)); appended = true; }
        }
        // a type parameter with the new() constraint (UMapC's and USetC's hasher and key-equal): its maker
        var od = t.OriginalDefinition;
        for (int i = 0; i < od.TypeParameters.Length; i++)
            if (od.TypeParameters[i].HasConstructorConstraint) { outv.Add(Maker(t.TypeArguments[i])); appended = true; }
        return (string.Join(", ", outv), appended);
    }

    /// <summary>() => a default T, as C#'s Elem&lt;T&gt;.Make (and new T()) makes it.</summary>
    static string Maker(ITypeSymbol t)
    {
        string body;
        if (IsNumeric(Under(t)) || t.SpecialType is SpecialType.System_Boolean or SpecialType.System_Char) body = DefaultOf(t);
        else if (IsStructType(t)) body = DefaultOf(t);
        else if (t is INamedTypeSymbol n && IsEngine(n) && n.TypeKind == TypeKind.Class && !n.IsAbstract && !n.IsStatic) body = "new " + TypeIdent(n) + "()";
        else if (t is INamedTypeSymbol r && IsRuntime(r) && r.TypeKind == TypeKind.Class && !r.IsAbstract && r.InstanceConstructors.Any(k => k.Parameters.Length == 0 || k.Parameters.All(p => p.IsOptional)))
        {
            // the constructor C#'s Elem<T>.Make calls (the parameterless one, or the one whose parameters are all
            // optional: the maps' hash, equality, ordering and maker), with the arguments C# would pass
            var nm = StripArity(r.Name);
            var ctor = r.InstanceConstructors.FirstOrDefault(k => k.Parameters.Length == 0) ?? r.InstanceConstructors.Where(k => k.Parameters.All(p => p.IsOptional)).OrderByDescending(k => k.Parameters.Length).First();
            var inner = new List<string>();
            bool hasFunc = false, appended = false;
            foreach (var p in ctor.Parameters)
            {
                if (p.Type is INamedTypeSymbol ft && IsSystem(ft) && ft.Name == "Func" && ft.TypeArguments.Length == 1 && makerSlots.ContainsKey(nm)) { hasFunc = true; inner.Add(Maker(ft.TypeArguments[0])); }
                else inner.Add(p.HasExplicitDefaultValue ? Const(p.ExplicitDefaultValue, p.Type) : "null");
            }
            if (!hasFunc && makerSlots.TryGetValue(nm, out var slots)) { inner.AddRange(slots.Select(k => Maker(r.TypeArguments[k]))); appended = true; }
            else if (nm is "Pair" or "Tup" && ctor.Parameters.Length == 0) { inner.AddRange(r.TypeArguments.Select(Maker)); appended = true; }
            var od = r.OriginalDefinition;
            for (int i = 0; i < od.TypeParameters.Length; i++) if (od.TypeParameters[i].HasConstructorConstraint) { inner.Add(Maker(r.TypeArguments[i])); appended = true; }
            body = NewRuntime(r, ctor, string.Join(", ", inner), appended);
        }
        else body = "null";
        return "(() => " + body + ")";
    }

    string NewArray(IArrayCreationOperation ac)
    {
        var at = (IArrayTypeSymbol)ac.Type!;
        var et = at.ElementType;
        if (ac.Initializer != null)
            return "[" + string.Join(", ", ac.Initializer.ElementValues.Select(v => Strip(Value(v, et)))) + "]";
        if (ac.DimensionSizes.Length != 1) return Todo("multidimensional array");
        return "new Array(" + Strip(Index(ac.DimensionSizes[0])) + ").fill(" + DefaultOf(et) + ")";
    }

    // ---- operators
    static string OpText(BinaryOperatorKind k) => k switch
    {
        BinaryOperatorKind.Add => "+", BinaryOperatorKind.Subtract => "-", BinaryOperatorKind.Multiply => "*",
        BinaryOperatorKind.Divide => "/", BinaryOperatorKind.Remainder => "%", BinaryOperatorKind.LeftShift => "<<",
        BinaryOperatorKind.RightShift => ">>", BinaryOperatorKind.And => "&", BinaryOperatorKind.Or => "|",
        BinaryOperatorKind.ExclusiveOr => "^", BinaryOperatorKind.ConditionalAnd => "&&", BinaryOperatorKind.ConditionalOr => "||",
        BinaryOperatorKind.Equals => "===", BinaryOperatorKind.NotEquals => "!==", BinaryOperatorKind.LessThan => "<",
        BinaryOperatorKind.LessThanOrEqual => "<=", BinaryOperatorKind.GreaterThan => ">", BinaryOperatorKind.GreaterThanOrEqual => ">=",
        _ => Todo("operator " + k)
    };

    static bool IsCompare(BinaryOperatorKind k) => k is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals or BinaryOperatorKind.LessThan or BinaryOperatorKind.LessThanOrEqual or BinaryOperatorKind.GreaterThan or BinaryOperatorKind.GreaterThanOrEqual;

    /// <summary>l op r for operands of C# type t (after C#'s promotions), the result in t's canonical form.</summary>
    static string BinOp(BinaryOperatorKind k, ITypeSymbol t, string l, string r)
    {
        var u = Under(t);
        if (k is BinaryOperatorKind.ConditionalAnd or BinaryOperatorKind.ConditionalOr) return "(" + l + " " + OpText(k) + " " + r + ")";
        switch (u.SpecialType)
        {
            case SpecialType.System_Double:
                return "(" + l + " " + OpText(k) + " " + r + ")";
            case SpecialType.System_Single:
                if (IsCompare(k)) return "(" + l + " " + OpText(k) + " " + r + ")";
                return "Math.fround(" + l + " " + OpText(k) + " " + r + ")";
            case SpecialType.System_Int32:
                switch (k)
                {
                    case BinaryOperatorKind.Add: case BinaryOperatorKind.Subtract: return "((" + l + " " + OpText(k) + " " + r + ") | 0)";
                    case BinaryOperatorKind.Multiply: return "Math.imul(" + Strip(l) + ", " + Strip(r) + ")";
                    // by a constant other than 0 and -1 neither throws nor overflows: JavaScript's / and % then | 0
                    case BinaryOperatorKind.Divide when ConstDivisor(r): return "((" + l + " / " + r + ") | 0)";
                    case BinaryOperatorKind.Remainder when ConstDivisor(r): return "((" + l + " % " + r + ") | 0)";
                    case BinaryOperatorKind.Divide: return L("divI") + "(" + Strip(l) + ", " + Strip(r) + ")";
                    case BinaryOperatorKind.Remainder: return L("remI") + "(" + Strip(l) + ", " + Strip(r) + ")";
                }
                return "(" + l + " " + OpText(k) + " " + r + ")";      // & | ^ << >> (count & 31, as C#) and comparisons
            case SpecialType.System_UInt32:
                switch (k)
                {
                    case BinaryOperatorKind.Add: case BinaryOperatorKind.Subtract: case BinaryOperatorKind.And: case BinaryOperatorKind.Or:
                    case BinaryOperatorKind.ExclusiveOr: case BinaryOperatorKind.LeftShift:
                        return "((" + l + " " + OpText(k) + " " + r + ") >>> 0)";
                    case BinaryOperatorKind.Multiply: return "(Math.imul(" + Strip(l) + ", " + Strip(r) + ") >>> 0)";
                    case BinaryOperatorKind.Divide: return L("divU") + "(" + Strip(l) + ", " + Strip(r) + ")";
                    case BinaryOperatorKind.Remainder: return L("remU") + "(" + Strip(l) + ", " + Strip(r) + ")";
                    case BinaryOperatorKind.RightShift: return "(" + l + " >>> " + r + ")";
                }
                return "(" + l + " " + OpText(k) + " " + r + ")";
            case SpecialType.System_Int64:
            case SpecialType.System_UInt64:
                {
                    bool uns = u.SpecialType == SpecialType.System_UInt64;
                    if (k == BinaryOperatorKind.Equals) return "(" + l + " == " + r + ")";
                    if (k == BinaryOperatorKind.NotEquals) return "(" + l + " != " + r + ")";
                    if (IsCompare(k)) return "(" + l + " " + OpText(k) + " " + r + ")";
                    var h = k switch
                    {
                        BinaryOperatorKind.Add => "add", BinaryOperatorKind.Subtract => "sub", BinaryOperatorKind.Multiply => "mul",
                        BinaryOperatorKind.Divide => "div", BinaryOperatorKind.Remainder => "rem", BinaryOperatorKind.And => "and",
                        BinaryOperatorKind.Or => "or", BinaryOperatorKind.ExclusiveOr => "xor", BinaryOperatorKind.LeftShift => "shl",
                        BinaryOperatorKind.RightShift => "shr", BinaryOperatorKind.UnsignedRightShift => "shrU",
                        _ => Todo("operator " + k + " on long")
                    };
                    if (h == "shrU") return L(uns ? "shrUL" : "ushrL") + "(" + Strip(l) + ", " + Strip(r) + ")";
                    return L(h + (uns ? "UL" : "L")) + "(" + Strip(l) + ", " + Strip(r) + ")";
                }
            case SpecialType.System_Boolean:
                switch (k)
                {
                    case BinaryOperatorKind.And: return H("cpp.R.bAnd", "bAnd(a, b): a & b for booleans (both evaluated)") + "(" + Strip(l) + ", " + Strip(r) + ")";
                    case BinaryOperatorKind.Or: return H("cpp.R.bOr", "bOr(a, b): a | b for booleans (both evaluated)") + "(" + Strip(l) + ", " + Strip(r) + ")";
                    case BinaryOperatorKind.ExclusiveOr: return "(" + l + " !== " + r + ")";
                }
                return "(" + l + " " + OpText(k) + " " + r + ")";
            case SpecialType.System_String:
                return "(" + l + " " + OpText(k) + " " + r + ")";
        }
        if (IsIntegral(u))
        {
            // an enum whose underlying type is 8 or 16 bits (C# promotes the integers themselves to int): compare as
            // they are; & | ^ of two values stay in the type; anything else is computed in int and narrowed, as
            // unchecked enum arithmetic wraps to the underlying type
            if (IsCompare(k) || k is BinaryOperatorKind.And or BinaryOperatorKind.Or or BinaryOperatorKind.ExclusiveOr)
                return "(" + l + " " + OpText(k) + " " + r + ")";
            return NumConv(BinOp(k, IntType, l, r), SpecialType.System_Int32, u.SpecialType);
        }
        return "(" + l + " " + OpText(k) + " " + r + ")";
    }

    static ITypeSymbol IntType => comp.GetSpecialType(SpecialType.System_Int32);

    static bool ConstDivisor(string r) => System.Text.RegularExpressions.Regex.IsMatch(r, @"^\(?-?[0-9]+\)?$") && r.Trim('(', ')') is not ("0" or "-1");

    string Binary(IBinaryOperation b)
    {
        if (b.OperatorMethod != null)
        {
            if (IsSystem(b.OperatorMethod) && b.OperatorMethod.ContainingType.SpecialType == SpecialType.System_String)
            {
                if (b.OperatorKind == BinaryOperatorKind.Add) return "(" + StrPart(b.LeftOperand) + " + " + StrPart(b.RightOperand) + ")";
                return "(" + X(b.LeftOperand) + " " + OpText(b.OperatorKind) + " " + X(b.RightOperand) + ")";
            }
            if (IsSystem(b.OperatorMethod) && b.OperatorMethod.ContainingType.TypeKind == TypeKind.Delegate)
            {
                if (b.OperatorKind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals)
                {
                    if (!IsNullConst(b.LeftOperand) && !IsNullConst(b.RightOperand)) Note("delegate comparison (reference equality in JavaScript)");
                    return NullOrRefEq(b);
                }
            }
            return UserBinary(b.OperatorMethod, Value(b.LeftOperand, b.OperatorMethod.Parameters[0].Type), Value(b.RightOperand, b.OperatorMethod.Parameters[1].Type));
        }
        if (b.IsLifted) Todo0("lifted operator on a nullable value (null operands not handled)");
        var lt = b.LeftOperand.Type;
        if (lt != null && lt.SpecialType == SpecialType.System_String && b.OperatorKind == BinaryOperatorKind.Add)
            return "(" + StrPart(b.LeftOperand) + " + " + StrPart(b.RightOperand) + ")";
        // reference and null comparisons
        if (b.OperatorKind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals && (lt == null || !(IsNumeric(Under(lt)) || lt.SpecialType is SpecialType.System_Boolean or SpecialType.System_Char)))
            return NullOrRefEq(b);
        var l = X(b.LeftOperand);
        var r = X(b.RightOperand);
        return BinOp(b.OperatorKind, lt ?? b.Type!, l, r);
    }

    static bool IsNullConst(IOperation o) => o.ConstantValue is { HasValue: true, Value: null };

    /// <summary>== and != on references: against null, == null (so that undefined counts too); otherwise identity.</summary>
    string NullOrRefEq(IBinaryOperation b)
    {
        var eq = b.OperatorKind == BinaryOperatorKind.Equals;
        if (IsNullConst(b.RightOperand)) return "(" + X(b.LeftOperand) + (eq ? " == null)" : " != null)");
        if (IsNullConst(b.LeftOperand)) return "(" + X(b.RightOperand) + (eq ? " == null)" : " != null)");
        return "(" + X(b.LeftOperand) + (eq ? " === " : " !== ") + X(b.RightOperand) + ")";
    }

    /// <summary>An operand of a string concatenation, as .NET's string.Concat writes it.</summary>
    string StrPart(IOperation o)
    {
        while (o is IConversionOperation cv && cv.Type?.SpecialType == SpecialType.System_Object) o = cv.Operand;
        var t = o.Type;
        var s = X(o);
        if (t == null || t.SpecialType == SpecialType.System_String) return s;
        var u = Under(t);
        if (t.TypeKind == TypeKind.Enum) Note("string concatenation with an enum (its number, not its name)");
        if (u.SpecialType == SpecialType.System_Char) return "String.fromCharCode(" + Strip(s) + ")";
        if (u.SpecialType == SpecialType.System_Boolean) return "(" + s + " ? \"True\" : \"False\")";
        if (IsIntegral(u)) return "String(" + Strip(s) + ")";
        return H("cpp.R.toStr", "toStr(x): x.ToString() as .NET writes it") + "(" + Strip(s) + ")";
    }

    string UserBinary(IMethodSymbol op, string l, string r)
    {
        var t = op.ContainingType;
        var opn = op.Name switch
        {
            "op_Equality" => "op_Eq", "op_Inequality" => "op_Ne", "op_Addition" => "op_Add", "op_Subtraction" => "op_Sub",
            "op_LessThan" => "op_Lt", "op_GreaterThan" => "op_Gt", "op_LessThanOrEqual" => "op_Le", "op_GreaterThanOrEqual" => "op_Ge",
            "op_Multiply" => "op_Mul", "op_Division" => "op_Div",
            _ => Todo("user operator " + op.Name)
        };
        if (!IsRuntime(op)) return Todo("engine operator");
        var overloads = t.GetMembers(op.Name).OfType<IMethodSymbol>().Count();
        var sfx = overloads > 1 ? "_" + string.Join("_", op.OriginalDefinition.Parameters.Select(p => ShortType(p.Type))) : "";
        var cn = RuntimeClass(t);
        Use("operator " + op.OriginalDefinition.ToDisplayString(), cn + "." + opn + sfx);
        return cn + "." + opn + sfx + "(" + Strip(l) + ", " + Strip(r) + ")";
    }

    string Unary(IUnaryOperation u)
    {
        if (u.OperatorMethod != null) return Todo("user unary operator");
        if (u.IsLifted) Todo0("lifted operator on a nullable value (null operands not handled)");
        var o = X(u.Operand);
        var t = Under(u.Operand.Type!);
        switch (u.OperatorKind)
        {
            case UnaryOperatorKind.Plus: return o;
            case UnaryOperatorKind.Not: return "(!" + Paren(o) + ")";
            case UnaryOperatorKind.Minus:
                switch (t.SpecialType)
                {
                    case SpecialType.System_Double: case SpecialType.System_Single: return "(-" + Paren(o) + ")";
                    case SpecialType.System_Int32: return "(-" + Paren(o) + " | 0)";
                    case SpecialType.System_Int64: return L("negL") + "(" + Strip(o) + ")";
                }
                return Todo("unary minus on " + t.ToDisplayString());
            case UnaryOperatorKind.BitwiseNegation:
                switch (t.SpecialType)
                {
                    case SpecialType.System_Int32: return "(~" + Paren(o) + ")";
                    case SpecialType.System_UInt32: return "(~" + Paren(o) + " >>> 0)";
                    case SpecialType.System_Int64: return L("notL") + "(" + Strip(o) + ")";
                    case SpecialType.System_UInt64: return L("notUL") + "(" + Strip(o) + ")";
                }
                return Todo("~ on " + t.ToDisplayString());
        }
        return Todo("unary " + u.OperatorKind);
    }

    string Ternary(IConditionalOperation c)
    {
        var cond = X(c.Condition);
        var t = c.Type!;
        // the condition keeps its parentheses: a ?: or an assignment there binds looser than the ?: around it
        if (c.IsRef) return "(" + cond + " ? " + Strip(RefOf(c.WhenTrue)) + " : " + Strip(RefOf(c.WhenFalse!)) + ").get()";
        return "(" + cond + " ? " + Value(c.WhenTrue, t) + " : " + Value(c.WhenFalse!, t) + ")";
    }

    string CondAccess(IConditionalAccessOperation ca)
    {
        var recv = X(ca.Operation);
        string r = recv, test;
        if (Trivial(recv)) test = r + " == null";
        else { r = Temp(); test = "(" + r + " = " + Strip(recv) + ") == null"; }
        condAccess.Push(r);
        var inner = X(ca.WhenNotNull);
        condAccess.Pop();
        return "(" + test + " ? null : " + Strip(inner) + ")";
    }

    /// <summary>Evaluating op has no effect, so the parts of a place it is combined with may be read twice.</summary>
    static bool Pure(IOperation op)
    {
        switch (op)
        {
            case ILiteralOperation: case ILocalReferenceOperation: case IParameterReferenceOperation: case IInstanceReferenceOperation:
            case IDefaultValueOperation:
                return true;
            case IFieldReferenceOperation f: return f.Instance == null || Pure(f.Instance);
            case IConversionOperation c: return c.OperatorMethod == null && Pure(c.Operand);
            case IBinaryOperation b: return b.OperatorMethod == null && Pure(b.LeftOperand) && Pure(b.RightOperand);
            case IUnaryOperation u: return u.OperatorMethod == null && Pure(u.Operand);
            case IArrayElementReferenceOperation ae: return Pure(ae.ArrayReference) && ae.Indices.All(Pure);
            case IConditionalOperation c: return !c.IsRef && Pure(c.Condition) && Pure(c.WhenTrue) && (c.WhenFalse == null || Pure(c.WhenFalse));
        }
        return op.ConstantValue.HasValue;
    }

    // ---- lambdas and delegates
    string Lambda(IAnonymousFunctionOperation af, ITypeSymbol? target)
    {
        var m = af.Symbol;
        var sub = new JsFn(this, m);
        var ps = string.Join(", ", m.Parameters.Select(p => sub.DeclareParam(p)));
        var body = new List<string>();
        var ends = sub.Block(af.Body.Operations, body, 2);
        if (ends && !m.ReturnsVoid) body.Add("\t\tthrow new Error(\"unreachable\");");
        var text = "((" + ps + ") => {\n" + sub.Prologue(2) + string.Concat(body.Select(l => l + "\n")) + "\t})";
        // a lambda returning a reference (RefAt, RefGet, MemPtr) that captures nothing is one value, as C# caches it:
        // Ptr's == compares the getter, so its identity must not change from one evaluation to the next
        if (m.RefKind != RefKind.None && !Captures(af)) return ModuleConst("lam", text);
        return text;
    }

    static bool Captures(IAnonymousFunctionOperation af)
    {
        foreach (var d in af.Body.Descendants())
        {
            if (d is IInstanceReferenceOperation) return true;
            ISymbol? s = d is ILocalReferenceOperation lr ? lr.Local : d is IParameterReferenceOperation pr ? pr.Parameter : null;
            if (s == null) continue;
            if (!IsInside(s.ContainingSymbol, af.Symbol)) return true;
        }
        return false;
    }

    static bool IsInside(ISymbol? s, ISymbol lambda)
    {
        for (var x = s; x != null; x = x.ContainingSymbol) if (SymbolEqualityComparer.Default.Equals(x, lambda)) return true;
        return false;
    }

    string DelegateCreation(IDelegateCreationOperation dc)
    {
        var t = dc.Type!;
        if (dc.Target is IAnonymousFunctionOperation af) return Lambda(af, t);
        if (dc.Target is IMethodReferenceOperation mr)
        {
            // a method group: an arrow function calling the method, its receiver evaluated now (as C# binds it)
            var m = mr.Method;
            var inv = ((INamedTypeSymbol)t).DelegateInvokeMethod!;
            var ps = inv.Parameters.Select((p, i) => "$a" + i).ToList();
            var decl = string.Join(", ", ps);
            string target;
            if (IsRuntime(m))
            {
                var nm = RuntimeName(m);
                Use((m.IsStatic ? "static " : "method ") + m.OriginalDefinition.ToDisplayString() + " (as a delegate)", m.IsStatic ? RuntimeClass(m.ContainingType) + "." + nm : nm);
                target = m.IsStatic ? RuntimeClass(m.ContainingType) + "." + nm : "$o." + nm;
            }
            else if (m.IsStatic) target = TypeIdent(m.ContainingType) + "." + MethodIdent(m);
            else target = "$o." + MethodIdent(m);
            var call = "((" + decl + ") => " + target + "(" + string.Join(", ", ps) + "))";
            if (m.IsStatic) return call;
            var recv = X(mr.Instance!);
            if (recv == "this") return call.Replace("$o.", "this.");
            return "(($o) => " + call + ")(" + Strip(recv) + ")";
        }
        return Todo("delegate creation " + dc.Target.Kind);
    }
}
}
