// a_ref.ts - part A of the TypeScript runtime (package cpp): C#'s ref T as an object (ts/RUNTIME_HELPERS.md,
// "References"). A Ref<T> has get() and set(v); the engine makes one for an address-taken local (Cell, whose value is
// the public field v), an array or vector element (ArrRef: a later reallocation of the vector does not move it, as a
// C# ref into the old array does not move), and a field (fieldRef). RefAt<T> is the C# delegate ref T RefAt<T>(object)
// that a pointer made by &obj.field keeps (cs/runtime/Std.cs).
// Written by Claude (Anthropic) for the SWMM6 ports; see AI-USE.md.

/** C#'s ref T: read with get(), write with set(v). */
export interface Ref<T> {
	get(): T;
	set(v: T): void;
}

/** The storage of a local or parameter whose address is taken: a Ref whose value is the field v. */
export class Cell<T> implements Ref<T> {
	v: T;
	constructor(v: T) { this.v = v; }
	get(): T { return this.v; }
	set(v: T): void { this.v = v; }
}

/** A Ref to a[i]: an array element (a JavaScript array, or the Uint8Array of a Str). */
export class ArrRef<T> implements Ref<T> {
	readonly a: { [i: number]: T };
	readonly i: number;
	constructor(a: { [i: number]: T }, i: number) { this.a = a; this.i = i; }
	get(): T { return this.a[this.i]; }
	set(v: T): void { this.a[this.i] = v; }
}

/** A Ref to the property k of the object (or class, for a static field) o. */
export class FieldRef<T> implements Ref<T> {
	readonly o: any;
	readonly k: string;
	constructor(o: any, k: string) { this.o = o; this.k = k; }
	get(): T { return this.o[this.k]; }
	set(v: T): void { this.o[this.k] = v; }
}

/** fieldRef(obj, name): a Ref to the property name of obj (the TypeScript field name). */
export function fieldRef<T = any>(o: any, name: string): Ref<T> { return new FieldRef<T>(o, name); }

/** C#'s delegate ref T RefAt<T>(object? o): given the object, a reference to one of its fields. The ones the engine
 *  passes capture nothing and are module-level constants, so the same lambda is the same function object. */
export type RefAt<T> = (o: any) => Ref<T>;
