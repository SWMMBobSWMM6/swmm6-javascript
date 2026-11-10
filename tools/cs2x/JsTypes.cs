// JsTypes.cs - the analyses the translation needs (address-taken locals, runtime members that depend on a type
// argument, the duck-typing check), and the declarations of the JavaScript engine: enums, classes in base-first
// order, constructors, and the static initialisation section. A copy of TsTypes.cs; the declarations carry no types
// (JS.md lists every change).
// Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see AI-USE.md and js/README.md.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

public static partial class Cs2Js
{
    static readonly List<INamedTypeSymbol> engineTypes = new();
    static readonly Dictionary<INamedTypeSymbol, int> typeOrder = new(SymbolEqualityComparer.Default);

    static bool IsEngine(ITypeSymbol t) => t is INamedTypeSymbol n && !IsRuntime(n) && !IsSystem(n) && n.Locations.Any(l => l.IsInSource);

    static void CollectTypes(List<SyntaxTree> gen)
    {
        var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        foreach (var t in gen)
        {
            foreach (var td in t.GetRoot().DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
            {
                var s = (INamedTypeSymbol)M(td).GetDeclaredSymbol(td)!;
                if (seen.Add(s)) { typeOrder[s] = engineTypes.Count; engineTypes.Add(s); }
            }
            foreach (var dd in t.GetRoot().DescendantNodes().OfType<DelegateDeclarationSyntax>())
            {
                var s = (INamedTypeSymbol)M(dd).GetDeclaredSymbol(dd)!;
                if (seen.Add(s)) { typeOrder[s] = engineTypes.Count; engineTypes.Add(s); }
            }
        }
        foreach (var s in engineTypes) topNames.Add(TypeIdent(s));
        foreach (var s in engineTypes)
        {
            if (s.IsGenericType) Todo0("generic engine type " + s.Name);
            if (s.TypeKind == TypeKind.Struct) Todo0("engine struct " + s.Name);
            if (s.TypeKind == TypeKind.Interface) Todo0("engine interface " + s.Name);
        }
    }

    // ------------------------------------------------------------------------------------------------ address-taken locals
    // A local or parameter is a cell (cpp.Cell) when its address is taken: a ref or out argument, a ref local, a ref
    // return or a ref conditional. JavaScript closures capture variables themselves, so (unlike Java) a captured
    // local needs no cell.
    static readonly HashSet<ISymbol> boxed = new(SymbolEqualityComparer.Default);

    static void Analyze(List<SyntaxTree> gen)
    {
        var addr = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        foreach (var t in gen)
        {
            var m = models[t];
            foreach (var node in t.GetRoot().DescendantNodes().Where(n => n is BaseMethodDeclarationSyntax || n is VariableDeclaratorSyntax && n.Parent?.Parent is FieldDeclarationSyntax))
            {
                IOperation? root = node switch
                {
                    BaseMethodDeclarationSyntax bm => bm.Body != null ? m.GetOperation(bm.Body) : bm.ExpressionBody != null ? m.GetOperation(bm.ExpressionBody) : null,
                    VariableDeclaratorSyntax vd => vd.Initializer != null ? m.GetOperation(vd.Initializer) : null,
                    _ => null
                };
                if (node is ConstructorDeclarationSyntax cds && cds.Initializer != null && m.GetOperation(cds.Initializer) is IOperation ci) Scan(ci);
                if (root != null) Scan(root);
            }
        }
        void Scan(IOperation root)
        {
            foreach (var op in root.DescendantsAndSelf())
            {
                switch (op)
                {
                    case IArgumentOperation a when a.Parameter != null && (a.Parameter.RefKind is RefKind.Ref or RefKind.Out or RefKind.In):
                        Mark(a.Value, addr); break;
                    case IVariableDeclaratorOperation vd when vd.Symbol.RefKind != RefKind.None && vd.Initializer != null:
                        Mark(vd.Initializer.Value, addr); break;
                    case IReturnOperation r when r.ReturnedValue != null && IsRefReturn(r):
                        Mark(r.ReturnedValue, addr); break;
                    case ISimpleAssignmentOperation sa when sa.IsRef:
                        Mark(sa.Value, addr); break;
                    case IConditionalOperation c when c.IsRef:
                        Mark(c.WhenTrue, addr); if (c.WhenFalse != null) Mark(c.WhenFalse, addr); break;
                }
            }
        }
        foreach (var s in addr) if (!IsRefSym(s)) boxed.Add(s);
    }

    static bool IsRefSym(ISymbol s) => s is ILocalSymbol l && l.RefKind != RefKind.None || s is IParameterSymbol p && p.RefKind != RefKind.None;

    static bool IsRefReturn(IReturnOperation r)
    {
        for (var p = r.Parent; p != null; p = p.Parent)
        {
            if (p is IAnonymousFunctionOperation af) return af.Symbol.RefKind != RefKind.None;
            if (p is IMethodBodyOperation || p is IBlockOperation && p.Parent == null) break;
        }
        var sm = r.SemanticModel;
        var md = r.Syntax.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault();
        return md != null && sm != null && sm.GetDeclaredSymbol(md) is IMethodSymbol ms && ms.RefKind != RefKind.None;
    }

    static void Mark(IOperation op, HashSet<ISymbol> set)
    {
        while (op is IConversionOperation cv && cv.Conversion.IsIdentity) op = cv.Operand;
        if (op is IDeclarationExpressionOperation de) op = de.Expression;      // out var x
        if (op is ILocalReferenceOperation l) set.Add(l.Local);
        else if (op is IParameterReferenceOperation p) set.Add(p.Parameter);
    }

    static void CollectFieldNames()
    {
        // the field names are computed on demand (FieldIdent); here the ones that had to change are recorded
        foreach (var s in engineTypes.Where(t => t.TypeKind == TypeKind.Class))
            foreach (var f in s.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsImplicitlyDeclared))
                if (FieldIdent(f) != f.Name.TrimStart('@')) Note("field renamed: " + s.Name + "." + f.Name + " -> " + FieldIdent(f));
    }

    // ------------------------------------------------------------------------------------------------ type-dependent runtime members
    // C# generics keep their type arguments at run time, JavaScript has none. Most runtime members do not care (a
    // value says what it is: a number, a Str, an engine object), and the element makers stand in for Elem<T>.Make.
    // A few do care: byte views of typed arrays (Mem, Bytes, stream read/write), bit casts, std::atomic's wrapping
    // fetch_add. Those are found here, from the C# runtime's own source, and every call to one gets a suffix naming
    // its type arguments (SpecCode): Bytes.View<double> is cpp.Bytes.View__d.
    static readonly HashSet<IMethodSymbol> typeDependent = new(SymbolEqualityComparer.Default);
    static readonly string[] DependentMarks = { "typeof(", "SizeOf<", "AsBytes", "MemoryMarshal", "Num.Add", "Num.Sub", "Bits.Cast", "Convert.ChangeType", "(T)(object)" };
    static readonly HashSet<string> ValueGeneric = new() { "Elem", "KeyCopy", "StdHash", "Less", "EqualTo", "Hash", "ArrCopy" };

    static void FindTypeDependent(List<SyntaxTree> rt)
    {
        var calls = new Dictionary<IMethodSymbol, List<(IMethodSymbol callee, ImmutableArrayHolder targs)>>(SymbolEqualityComparer.Default);
        var all = new List<IMethodSymbol>();
        foreach (var t in rt)
        {
            var m = models[t];
            foreach (var md in t.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>())
            {
                var s = m.GetDeclaredSymbol(md) as IMethodSymbol;
                if (s == null || !IsRuntime(s)) continue;
                var tps = TypeParamsInScope(s);
                if (tps.Count == 0) continue;
                if (ValueGeneric.Contains(StripArity(s.ContainingType.Name))) continue;
                all.Add(s);
                SyntaxNode? body = (SyntaxNode?)md.Body ?? md.ExpressionBody;
                if (body == null) continue;
                // the tests the element makers answer (is T a value type, a class, an array; T's parameterless
                // constructor; Clone by reflection) do not make a member type-dependent
                var text = System.Text.RegularExpressions.Regex.Replace(body.ToString(),
                    @"typeof\(\w+\)\.(IsValueType|IsClass|IsArray|GetConstructor\([^)]*\)|GetMethod\([^)]*\))|Activator\.CreateInstance\(typeof\(\w+\)\)", "");
                if (DependentMarks.Any(text.Contains) || s.ContainingType.Name == "Num") typeDependent.Add(s.OriginalDefinition);
                var lst = new List<(IMethodSymbol, ImmutableArrayHolder)>();
                foreach (var inv in body.DescendantNodes().OfType<InvocationExpressionSyntax>())
                    if (m.GetSymbolInfo(inv).Symbol is IMethodSymbol cs && IsRuntime(cs))
                        lst.Add((cs.OriginalDefinition, new ImmutableArrayHolder(cs.TypeArguments.Concat(AllTypeArgs(cs.ContainingType)).ToList())));
                calls[s.OriginalDefinition] = lst;
            }
        }
        for (bool changed = true; changed;)
        {
            changed = false;
            foreach (var s in all)
            {
                var d = s.OriginalDefinition;
                if (typeDependent.Contains(d) || !calls.TryGetValue(d, out var lst)) continue;
                var tps = TypeParamsInScope(d);
                if (lst.Any(c => typeDependent.Contains(c.callee) && c.targs.L.Any(a => a is ITypeParameterSymbol tp && tps.Contains(tp, SymbolEqualityComparer.Default))))
                { typeDependent.Add(d); changed = true; }
            }
        }
        foreach (var d in typeDependent) Note("type-dependent runtime member (calls get a type suffix): " + d.ToDisplayString());
    }

    sealed class ImmutableArrayHolder { public readonly List<ITypeSymbol> L; public ImmutableArrayHolder(List<ITypeSymbol> l) { L = l; } }

    static List<ITypeParameterSymbol> TypeParamsInScope(IMethodSymbol s)
    {
        var l = new List<ITypeParameterSymbol>(s.TypeParameters);
        for (var c = s.ContainingType; c != null; c = c.ContainingType) l.AddRange(c.TypeParameters);
        return l;
    }

    static IEnumerable<ITypeSymbol> AllTypeArgs(INamedTypeSymbol? t)
    {
        var l = new List<ITypeSymbol>();
        for (var c = t; c != null; c = c.ContainingType) l.InsertRange(0, c.TypeArguments);
        return l;
    }

    /// <summary>The specialisation suffix of a call to a type-dependent runtime member: __ and the codes of the
    /// class's type arguments, then the method's.</summary>
    static string Spec(IMethodSymbol m)
    {
        if (!typeDependent.Contains(m.OriginalDefinition)) return "";
        var args = AllTypeArgs(m.ContainingType).Concat(m.TypeArguments).ToList();
        if (args.Count == 0) return "";
        return "__" + string.Join("_", args.Select(SpecCode));
    }

    // ------------------------------------------------------------------------------------------------ duck typing
    // The JavaScript runtime cannot ask what interface a class implements; it asks the object for the method (Clone,
    // Dispose, HashOf, Call2, CompareTo). That is exact only if every engine class has the method exactly when it
    // implements the interface. Checked here; a mismatch is a TODO.
    static void CheckDuckTyping()
    {
        foreach (var s in engineTypes.Where(t => t.TypeKind == TypeKind.Class && !t.IsStatic))
        {
            bool Has(string name, int nparams)
            {
                for (var c = s; c != null && !IsSystem(c); c = c.BaseType)
                    if (c.GetMembers(name).OfType<IMethodSymbol>().Any(x => !x.IsStatic && x.Parameters.Length == nparams && x.MethodKind == MethodKind.Ordinary)) return true;
                return false;
            }
            bool Impl(string iname) => s.AllInterfaces.Any(i => (IsRuntime(i) || IsSystem(i)) && StripArity(i.Name) == iname);
            void Check(string iname, string meth, int np)
            {
                if (Impl(iname) != Has(meth, np)) Todo0("duck typing differs from the interface: " + s.Name + (Impl(iname) ? " implements " : " does not implement ") + iname + " but " + (Has(meth, np) ? "has " : "has no ") + meth);
            }
            Check("IDisposable", "Dispose", 0);
            Check("ICopy", "Clone", 0);
            Check("ICopy", "Assign", 1);
            Check("IHashFn", "HashOf", 1);
            Check("IBinFn", "Call2", 2);
            Check("IComparable", "CompareTo", 1);
            foreach (var mm in s.GetMembers().OfType<IMethodSymbol>())
                if (mm.IsOverride && mm.OverriddenMethod != null && IsSystem(mm.OverriddenMethod)) Note("engine class overrides System.Object." + mm.Name + ": " + s.Name);
        }
    }

    // ------------------------------------------------------------------------------------------------ types
    // JavaScript declares no types: of TsTypes.cs's type printers (Ts, FnType, RefType, ...) only the runtime class
    // name is needed, for new, extends, instanceof and static members.

    /// <summary>A runtime class: cpp.Name (nested classes joined by dots), recorded in the manifest.</summary>
    static string RuntimeClass(INamedTypeSymbol n)
    {
        var parts = new List<string>();
        for (var c = n; c != null; c = c.ContainingType) parts.Insert(0, StripArity(c.Name));
        var s = "cpp." + string.Join(".", parts);
        Use("type " + n.OriginalDefinition.ToDisplayString(), s);
        return s;
    }

    static bool IsStructType(ITypeSymbol t) => t.TypeKind == TypeKind.Struct && t.SpecialType == SpecialType.None && !(t is INamedTypeSymbol n && n.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T);

    /// <summary>The value a field, array element or local of type t starts with (C#'s default).</summary>
    static string DefaultOf(ITypeSymbol t)
    {
        if (t.SpecialType == SpecialType.System_Boolean) return "false";
        if (IsNumeric(Under(t)) || t.SpecialType == SpecialType.System_Char) return "0";
        if (IsStructType(t) && t is INamedTypeSymbol n)
        {
            if (IsRuntime(n))
            {
                var cn = RuntimeClass(n);
                Use("static " + n.OriginalDefinition.ToDisplayString() + ".ZERO (the default value; one for every T)", cn + ".ZERO");
                return cn + ".ZERO";
            }
            return Todo("engine struct " + n.Name);
        }
        return "null";
    }

    static bool IsFloat(ITypeSymbol? t) => t != null && (t.SpecialType == SpecialType.System_Double || t.SpecialType == SpecialType.System_Single);
    static bool IsIntegral(ITypeSymbol? t) => t != null && t.SpecialType is SpecialType.System_Int32 or SpecialType.System_Int64 or SpecialType.System_UInt32 or SpecialType.System_UInt64 or SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_SByte or SpecialType.System_Byte or SpecialType.System_Char;
    static bool IsNumeric(ITypeSymbol? t) => IsFloat(t) || IsIntegral(t);
    static bool IsLong(ITypeSymbol? t) => t != null && Under(t).SpecialType is SpecialType.System_Int64 or SpecialType.System_UInt64;
    static ITypeSymbol Under(ITypeSymbol t) => t.TypeKind == TypeKind.Enum && t is INamedTypeSymbol e ? e.EnumUnderlyingType! : t;

    // ------------------------------------------------------------------------------------------------ declarations
    static void EnumDecl(INamedTypeSymbol s, StringBuilder sb)
    {
        var ut = s.EnumUnderlyingType!;
        sb.Append("export const ").Append(TypeIdent(s)).Append(" = Object.freeze({");
        var first = true;
        foreach (var f in s.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue))
        {
            sb.Append(first ? " " : ", ").Append(Quote(f.Name)).Append(": ").Append(JsFn.Const(f.ConstantValue, ut));
            first = false;
        }
        sb.Append(" });\n");
    }

    static string Quote(string n) => System.Text.RegularExpressions.Regex.IsMatch(n, "^[A-Za-z_$][A-Za-z0-9_$]*$") ? n : JsFn.JStr(n);

    /// <summary>A delegate type is a TypeScript type alias (TsTypes.cs); JavaScript has no declaration for it: a
    /// delegate is a function value.</summary>
    static void DelegateDecl(INamedTypeSymbol s, StringBuilder sb) { }

    /// <summary>The classes in an order where every base class precedes the classes derived from it (otherwise the
    /// order of the C# sources).</summary>
    static List<INamedTypeSymbol> ClassOrder()
    {
        var done = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        var order = new List<INamedTypeSymbol>();
        void Visit(INamedTypeSymbol t)
        {
            t = t.OriginalDefinition;
            if (done.Contains(t)) return;
            done.Add(t);
            if (t.BaseType != null && IsEngine(t.BaseType)) Visit(t.BaseType);
            order.Add(t);
        }
        foreach (var s in engineTypes.Where(t => t.TypeKind == TypeKind.Class)) Visit(s);
        return order;
    }

    // ---- static fields: inline, or set after every class exists
    sealed class Deferred { public IFieldSymbol F = null!; public string Code = ""; public IOperation Init = null!; public int Order; }
    static readonly List<Deferred> deferred = new();

    static void ClassDecl(INamedTypeSymbol s, StringBuilder sb)
    {
        var nm = TypeIdent(s);
        var head = new StringBuilder("export ");
        head.Append("class ").Append(nm);       // (an abstract class is a plain class: C# never makes one)
        var b = s.BaseType;
        bool hasBase = false;
        if (b != null && b.SpecialType != SpecialType.System_Object)
        {
            if (IsEngine(b)) { head.Append(" extends ").Append(TypeIdent(b)); hasBase = true; }
            else if (IsRuntime(b)) { head.Append(" extends ").Append(RuntimeClass(b)); hasBase = true; Use("base class " + b.OriginalDefinition.ToDisplayString(), RuntimeClass(b)); }
            else Todo0("base type " + b.ToDisplayString());
        }
        foreach (var i in s.Interfaces)
            if (!(IsRuntime(i) || IsSystem(i) && (i.Name is "IDisposable" or "IEquatable" or "IComparable"))) Todo0("interface " + i.ToDisplayString());
        sb.Append(head).Append(" {\n");

        foreach (var f in s.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsImplicitlyDeclared))
        {
            try { FieldDecl(f, sb); }
            catch (Todo e) { sb.Append("\t// TODO field ").Append(f.Name).Append(": ").Append(e.Message).Append('\n'); }
        }
        var decls = s.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<ClassDeclarationSyntax>().ToList();
        var ctors = decls.SelectMany(cd => cd.Members.OfType<ConstructorDeclarationSyntax>()).ToList();
        try { CtorDecl(s, ctors.Where(c => !c.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword))).ToList(), hasBase, sb); }
        catch (Todo e) { sb.Append("\t// TODO constructor: ").Append(e.Message).Append('\n'); }
        foreach (var sc in ctors.Where(c => c.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword)))) StaticCtor(sc, s);
        foreach (var cd in decls)
            foreach (var m in cd.Members)
            {
                try
                {
                    switch (m)
                    {
                        case MethodDeclarationSyntax md: MethodDecl(md, s, sb); break;
                        case ConstructorDeclarationSyntax: break;
                        case FieldDeclarationSyntax: break;
                        case BaseTypeDeclarationSyntax: break;      // nested: a class of its own
                        case DelegateDeclarationSyntax: break;
                        default: sb.Append("\t// TODO member ").Append(m.Kind()).Append('\n'); Todo0("member " + m.Kind()); break;
                    }
                }
                catch (Todo e) { sb.Append("\t// TODO ").Append(e.Message).Append('\n'); }
                catch (Exception e) when (e is not global::Todo) { sb.Append("\t// TODO translator error: ").Append(e.GetType().Name).Append(' ').Append(e.Message.Replace("\n", " ")).Append('\n'); Todo0("translator error " + e.GetType().Name); }
            }
        sb.Append("}\n\n");
    }

    static void FieldDecl(IFieldSymbol f, StringBuilder sb)
    {
        var name = FieldIdent(f);
        if (f.IsConst)
        {
            sb.Append("\tstatic ").Append(name).Append(" = ").Append(JsFn.Const(f.ConstantValue, f.Type)).Append(";\n");
            return;
        }
        var stat = f.IsStatic ? "static " : "";
        var syn = f.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<VariableDeclaratorSyntax>().FirstOrDefault();
        if (syn?.Initializer != null)
        {
            var op = M(syn).GetOperation(syn.Initializer) is IFieldInitializerOperation fi ? fi.Value : M(syn).GetOperation(syn.Initializer.Value);
            if (op == null) Todo("field initializer");
            var fn = new JsFn(null, f.ContainingType);
            var val = fn.Value(op!, f.Type);
            val = fn.WrapTemps(val);
            if (f.IsStatic && !RuntimeOnly(op!))
            {
                // set after every class exists, in dependency order; until then it holds C#'s default
                sb.Append("\tstatic ").Append(name).Append(" = ").Append(DefaultOf(f.Type)).Append(";\n");
                deferred.Add(new Deferred { F = f, Code = TypeIdent(f.ContainingType) + "." + name + " = " + val + ";", Init = op!, Order = deferred.Count });
                return;
            }
            sb.Append('\t').Append(stat).Append(name).Append(" = ").Append(val).Append(";\n");
            return;
        }
        sb.Append('\t').Append(stat).Append(name).Append(" = ").Append(DefaultOf(f.Type)).Append(";\n");
    }

    /// <summary>The initializer refers to no engine class, so it can run while the class is being defined.</summary>
    static bool RuntimeOnly(IOperation op)
    {
        foreach (var o in op.DescendantsAndSelf())
        {
            if (o.ConstantValue.HasValue) continue;
            if (o.Type != null && MentionsEngineClass(o.Type)) return false;
            switch (o)
            {
                case IFieldReferenceOperation fr when IsEngine(fr.Field.ContainingType) && fr.Field.ContainingType.TypeKind != TypeKind.Enum: return false;
                case IInvocationOperation inv when IsEngine(inv.TargetMethod.ContainingType) || inv.TargetMethod.TypeArguments.Any(MentionsEngineClass): return false;
                case IObjectCreationOperation oc when oc.Type != null && MentionsEngineClass(oc.Type): return false;
                case IMethodReferenceOperation mr when IsEngine(mr.Method.ContainingType): return false;
            }
        }
        return true;
    }

    static bool MentionsEngineClass(ITypeSymbol t)
    {
        if (t is IArrayTypeSymbol at) return MentionsEngineClass(at.ElementType);
        if (t is INamedTypeSymbol n)
        {
            if (IsEngine(n) && n.TypeKind == TypeKind.Class) return true;
            return n.TypeArguments.Any(MentionsEngineClass);
        }
        return false;
    }

    static void StaticCtor(ConstructorDeclarationSyntax sc, INamedTypeSymbol s)
    {
        var c = (IMethodSymbol)M(sc).GetDeclaredSymbol(sc)!;
        var fn = new JsFn(c, s);
        var body = sc.Body != null ? fn.Body(M(sc).GetOperation(sc.Body)!, c, 1) : "";
        var code = "(() => {\n" + fn.Prologue(1) + body + "})();";
        IOperation init = M(sc).GetOperation((SyntaxNode?)sc.Body ?? sc)!;
        deferred.Add(new Deferred { F = null!, Code = code, Init = init, Order = deferred.Count });
        Note("static constructor: " + s.Name);
    }

    static void MethodDecl(MethodDeclarationSyntax md, INamedTypeSymbol s, StringBuilder sb)
    {
        var m = (IMethodSymbol)M(md).GetDeclaredSymbol(md)!;
        var fn = new JsFn(m, s);
        if (m.IsGenericMethod) Todo0("generic engine method " + m.Name);
        // an abstract method is a declaration only in TypeScript; JavaScript has nothing to declare (every concrete
        // class C# allows overrides it, and a call dispatches on the object)
        if (m.IsAbstract) return;
        var head = new StringBuilder("\t");
        if (m.IsStatic) head.Append("static ");
        head.Append(MethodIdent(m));
        head.Append('(').Append(string.Join(", ", m.Parameters.Select(p => fn.DeclareParam(p)))).Append(')');
        string body;
        IOperation? op = md.Body != null ? M(md).GetOperation(md.Body) : md.ExpressionBody != null ? M(md).GetOperation(md.ExpressionBody) : null;
        try { body = op == null ? "" : fn.Body(op, m, 2); }
        catch (Todo e) { body = "\t\tthrow new Error(\"TODO " + JsFn.Esc(e.Message) + "\");\n"; }
        sb.Append(head).Append(" {\n").Append(fn.Prologue(2)).Append(body).Append("\t}\n\n");
    }

    /// <summary>The constructor. JavaScript has one per class: a class with one C# constructor takes its parameters;
    /// a class with several (the generated classes have X(Raw), which leaves the object for an __init method, and
    /// X() : this(Raw.V) { __init_d(); }) takes them all as a rest parameter and picks the C# constructor by the
    /// number of arguments, which the translator checks is different for each. The arguments of every this(...) and
    /// base(...) are evaluated first, as in C#; then super(...) runs the base class's constructor; then the bodies,
    /// innermost first. One difference: TypeScript initialises a class's fields after its base constructor has
    /// returned, C# before calling it (the generated field initializers are defaults, which no base constructor reads).</summary>
    static void CtorDecl(INamedTypeSymbol s, List<ConstructorDeclarationSyntax> ctors, bool hasBase, StringBuilder sb)
    {
        if (s.IsStatic || ctors.Count == 0) return;      // the implicit constructor: JavaScript's passes no arguments to super(), as C#'s base()
        var syms = ctors.Select(cd => (IMethodSymbol)M(cd).GetDeclaredSymbol(cd)!).ToList();
        if (syms.Select(c => c.Parameters.Length).Distinct().Count() != syms.Count) Todo("constructors of one class with the same number of parameters");
        if (syms.Any(c => c.Parameters.Any(p => p.IsParams || p.IsOptional))) Todo("constructor with optional or params parameters");
        var fn = new JsFn(syms[0], s);
        var byCtor = new Dictionary<IMethodSymbol, ConstructorDeclarationSyntax>(SymbolEqualityComparer.Default);
        for (int i = 0; i < syms.Count; i++) byCtor[syms[i].OriginalDefinition] = ctors[i];

        if (ctors.Count == 1)
        {
            var c = syms[0];
            var cd = ctors[0];
            var ps = string.Join(", ", c.Parameters.Select(p => fn.DeclareParam(p)));
            string? superCall = null;
            if (cd.Initializer != null && M(cd).GetOperation(cd.Initializer) is IOperation init)
            {
                if (Unwrap(init) is not IInvocationOperation ci) { Todo("constructor initializer " + init.Kind); return; }
                if (cd.Initializer.ThisOrBaseKeyword.IsKind(SyntaxKind.ThisKeyword)) Todo("this(...) in a class with one constructor");
                if (hasBase) superCall = "super(" + fn.Args(ci.TargetMethod, ci.Arguments) + ");";
            }
            else if (hasBase) superCall = "super();";
            var body = cd.Body != null ? fn.Body(M(cd).GetOperation(cd.Body)!, c, 2) : "";
            sb.Append("\tconstructor(").Append(ps).Append(") {\n").Append(fn.Prologue(2));
            if (superCall != null) sb.Append("\t\t").Append(superCall).Append('\n');
            sb.Append(body).Append("\t}\n\n");
            return;
        }

        // several constructors: one with a rest parameter, dispatching on the number of arguments
        var arms = new List<(int k, List<(string n, string set, bool trivial)> binds, string sargs, string bodies)>();
        foreach (var c in syms)
        {
            // the chain of constructors this one runs: itself, then this(...)'s target, ... down to the one calling base(...)
            var chain = new List<IMethodSymbol> { c.OriginalDefinition };
            for (var x = c.OriginalDefinition; ;)
            {
                var cdx = byCtor[x];
                if (cdx.Initializer == null || !cdx.Initializer.ThisOrBaseKeyword.IsKind(SyntaxKind.ThisKeyword)) break;
                var ci = (IInvocationOperation)Unwrap(M(cdx).GetOperation(cdx.Initializer)!);
                x = ci.TargetMethod.OriginalDefinition;
                if (chain.Contains(x, SymbolEqualityComparer.Default)) Todo("constructor chain loops");
                chain.Add(x);
            }
            var binds = new List<(string n, string set, bool trivial)>();
            foreach (var p in c.Parameters) { var b = fn.BindCtorParam(p, "$a[" + p.Ordinal + "]"); binds.Add((b.name, b.set, true)); }
            string sargs = "";
            for (int i = 0; i < chain.Count; i++)
            {
                var cdx = byCtor[chain[i]];
                if (cdx.Initializer == null || M(cdx).GetOperation(cdx.Initializer) is not IOperation init) continue;
                var ci = (IInvocationOperation)Unwrap(init);
                if (cdx.Initializer.ThisOrBaseKeyword.IsKind(SyntaxKind.ThisKeyword))
                {
                    // this(...): its arguments are the next constructor's parameters
                    var next = chain[i + 1];
                    var vals = fn.ArgList(ci.TargetMethod, ci.Arguments);
                    for (int j = 0; j < next.Parameters.Length; j++)
                    {
                        var b = fn.BindCtorParam(next.Parameters[j], vals[j]);
                        binds.Add((b.name, b.set, TsFnTrivial(vals[j])));
                    }
                }
                else sargs = fn.Args(ci.TargetMethod, ci.Arguments);
            }
            // the bodies, innermost (the one that called base) first; a return in an inner one leaves only that body
            var bodies = new StringBuilder();
            for (int i = chain.Count - 1; i >= 0; i--)
            {
                var cdx = byCtor[chain[i]];
                if (cdx.Body == null || cdx.Body.Statements.Count == 0) continue;
                var op = M(cdx).GetOperation(cdx.Body)!;
                var text = fn.Body(op, chain[i], 3);
                if (i > 0 && op.Descendants().Any(d => d is IReturnOperation)) { text = "\t\t\t(() => {\n" + text + "\t\t\t})();\n"; Note("constructor body with return, run as a function"); }
                bodies.Append(text);
            }
            arms.Add((c.Parameters.Length, binds, sargs, bodies.ToString()));
        }
        var read = fn.ReadParams;
        var kept = arms.Select(a => a.binds.Where(b => read.Contains(b.n) || !b.trivial).ToList()).ToList();
        var declared = kept.SelectMany(b => b.Select(x => x.n)).Distinct().ToList();
        bool sameSuper = arms.Select(a => a.sargs).Distinct().Count() == 1 && !arms.Any(a => a.binds.Any(b => System.Text.RegularExpressions.Regex.IsMatch(a.sargs, "(?<![\\w$])" + System.Text.RegularExpressions.Regex.Escape(b.n) + "(?![\\w$])")));
        sb.Append("\tconstructor(...$a) {\n").Append(fn.Prologue(2));
        if (declared.Count > 0) sb.Append("\t\tlet ").Append(string.Join(", ", declared)).Append(";\n");
        if (hasBase && !sameSuper) sb.Append("\t\tlet $s = [];\n");
        bool firstPre = true;
        for (int i = 0; i < arms.Count; i++)
        {
            var a = arms[i];
            var setS = hasBase && !sameSuper;
            if (kept[i].Count == 0 && !setS) continue;
            sb.Append("\t\t").Append(firstPre ? "if" : "else if").Append(" ($a.length === ").Append(a.k).Append(") {\n");
            foreach (var b in kept[i]) sb.Append("\t\t\t").Append(b.set).Append('\n');
            if (setS) sb.Append("\t\t\t$s = [").Append(a.sargs).Append("];\n");
            sb.Append("\t\t}\n");
            firstPre = false;
        }
        if (hasBase) sb.Append("\t\t").Append(sameSuper ? "super(" + arms[0].sargs + ");\n" : "super(...$s);\n");
        bool firstPost = true;
        foreach (var a in arms)
        {
            if (a.bodies.Length == 0) continue;
            sb.Append("\t\t").Append(firstPost ? "if" : "else if").Append(" ($a.length === ").Append(a.k).Append(") {\n").Append(a.bodies).Append("\t\t}\n");
            firstPost = false;
        }
        sb.Append("\t}\n\n");
    }

    static bool TsFnTrivial(string s) => System.Text.RegularExpressions.Regex.IsMatch(s, @"^(this|[A-Za-z_$][\w$]*)(\.[A-Za-z_$][\w$]*)*$|^\(?-?[0-9][0-9.eE+\-]*n?\)?$");

    static IOperation Unwrap(IOperation init) => init is IExpressionStatementOperation es ? es.Operation : init;

    // ---- the static initialisation section
    /// <summary>The static fields whose initializers involve engine classes, set after every class is defined, in an
    /// order where a field is set before any initializer that may read it runs (the reads are followed through the
    /// engine methods and constructors the initializer calls). C# sets a class's statics before their first use;
    /// this order gives every initializer the values it reads, as C# would.</summary>
    static string StaticInitSection()
    {
        if (deferred.Count == 0) return "";
        var byField = deferred.Where(d => d.F != null).ToDictionary(d => (ISymbol)d.F.OriginalDefinition, d => d, SymbolEqualityComparer.Default);
        var deps = new Dictionary<Deferred, HashSet<Deferred>>();
        foreach (var d in deferred)
        {
            var reads = new HashSet<Deferred>();
            var seenM = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            var seenT = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            var work = new Stack<IOperation>();
            work.Push(d.Init);
            while (work.Count > 0)
            {
                var root = work.Pop();
                foreach (var o in root.DescendantsAndSelf())
                {
                    switch (o)
                    {
                        case IFieldReferenceOperation fr when fr.Field.IsStatic && byField.TryGetValue(fr.Field.OriginalDefinition, out var g) && g != d:
                            reads.Add(g); break;
                        case IInvocationOperation inv when IsEngine(inv.TargetMethod.ContainingType):
                            foreach (var b in MethodOps(inv.TargetMethod, seenM)) work.Push(b);
                            if (inv.IsVirtual) foreach (var t in Descendants(inv.TargetMethod.ContainingType))
                                    foreach (var ov in t.GetMembers(inv.TargetMethod.Name).OfType<IMethodSymbol>().Where(x => x.IsOverride))
                                        foreach (var b in MethodOps(ov, seenM)) work.Push(b);
                            break;
                        case IMethodReferenceOperation mr when IsEngine(mr.Method.ContainingType):
                            foreach (var b in MethodOps(mr.Method, seenM)) work.Push(b);
                            break;
                    }
                    if (o.Type != null)
                        foreach (var t in EngineClassesIn(o.Type))
                            foreach (var b in ClassInitOps(t, seenT, seenM)) work.Push(b);
                }
            }
            deps[d] = reads;
        }
        // Kahn's algorithm, ties broken by source order
        var outSb = new StringBuilder("// ---- static initialisation: the static fields whose initializers involve engine classes, in dependency order\n");
        var left = new List<Deferred>(deferred);
        var doneSet = new HashSet<Deferred>();
        while (left.Count > 0)
        {
            var next = left.FirstOrDefault(d => deps[d].All(doneSet.Contains));
            if (next == null) { next = left[0]; Todo0("static initializers that depend on each other (a cycle): " + (next.F?.Name ?? "static constructor")); }
            left.Remove(next);
            doneSet.Add(next);
            outSb.Append(next.Code).Append('\n');
        }
        return outSb.ToString();
    }

    static IEnumerable<INamedTypeSymbol> EngineClassesIn(ITypeSymbol t)
    {
        if (t is IArrayTypeSymbol at) { foreach (var x in EngineClassesIn(at.ElementType)) yield return x; yield break; }
        if (t is INamedTypeSymbol n)
        {
            if (IsEngine(n) && n.TypeKind == TypeKind.Class) yield return n.OriginalDefinition;
            foreach (var a in n.TypeArguments) foreach (var x in EngineClassesIn(a)) yield return x;
        }
    }

    static IEnumerable<IOperation> MethodOps(IMethodSymbol m, HashSet<ISymbol> seen)
    {
        m = m.OriginalDefinition;
        if (!seen.Add(m)) yield break;
        foreach (var r in m.DeclaringSyntaxReferences)
        {
            var syn = r.GetSyntax();
            var model = M(syn);
            if (syn is BaseMethodDeclarationSyntax bm)
            {
                if (bm is ConstructorDeclarationSyntax cds && cds.Initializer != null && model.GetOperation(cds.Initializer) is IOperation ci) yield return ci;
                var op = bm.Body != null ? model.GetOperation(bm.Body) : bm.ExpressionBody != null ? model.GetOperation(bm.ExpressionBody) : null;
                if (op != null) yield return op;
            }
        }
    }

    /// <summary>What making an object of class t runs: its field initializers and constructors, and its bases'.</summary>
    static IEnumerable<IOperation> ClassInitOps(INamedTypeSymbol t, HashSet<ISymbol> seenT, HashSet<ISymbol> seenM)
    {
        var res = new List<IOperation>();
        for (var c = t; c != null && IsEngine(c); c = c.BaseType)
        {
            if (!seenT.Add(c.OriginalDefinition)) break;
            foreach (var f in c.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsStatic))
                foreach (var r in f.DeclaringSyntaxReferences)
                    if (r.GetSyntax() is VariableDeclaratorSyntax vd && vd.Initializer != null && M(vd).GetOperation(vd.Initializer) is IOperation fi) res.Add(fi);
            foreach (var k in c.InstanceConstructors) res.AddRange(MethodOps(k, seenM));
        }
        return res;
    }
}
