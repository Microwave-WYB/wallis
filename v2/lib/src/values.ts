// Values that cross the body, the journal and the sandbox: artifact refs,
// Trees, addresses, and the schema builders that mark where they are.
//
// A ref in the journal has no `path`: identity is the digest. `path` is
// added where the ref is seen: the blob's (or Tree's layer's) host path in
// the store for bodies and callers, the mount point inside a sandbox for
// commands and agents (`withPaths`, `stripPaths`).

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import Type, { type Static, type TSchema, type TUnsafe } from "typebox";
import Value from "typebox/value";
import type { Json } from "./host/core.ts";

export { Type };
export type { Static, TSchema };

/** The JSON Schema keyword that marks a wallis value's position. */
export const MARK = "x-wallis";

/** A content-addressed file in the project store. `path` is where it is mounted in the current sandbox. */
export interface ArtifactRef<M extends string = string> {
	readonly kind: "artifact";
	readonly digest: string;
	readonly name: string;
	readonly media: M;
	readonly path: string;
}

/** A directory snapshot in the project store, mounted read-only at `path`. */
export interface TreeRef {
	readonly kind: "tree";
	readonly digest: string;
	readonly path: string;
}

/** Where messages of type `M` can be sent. A plain value: pass it in inputs, messages and outputs. */
export interface Address<M = unknown> {
	readonly kind: "address";
	readonly id: string;
	/** Phantom: the message type. */
	__message?(m: M): void;
}

export type MessageId = string & { readonly __messageId: true };

const DIGEST = "^sha256:[0-9a-f]{64}$";
const DIGEST_RE = new RegExp(DIGEST);

// --- Caller-only host files -------------------------------------------------------

/** `Artifact.from` / `Tree.from`: a host path the caller's `run` ingests into the store when the run starts. */
export class HostPath {
	readonly kind: "artifact" | "tree";
	readonly host: string;
	readonly media: string | undefined;
	readonly name: string | undefined;
	constructor(kind: "artifact" | "tree", host: string, media?: string, name?: string) {
		this.kind = kind;
		this.host = resolve(host);
		this.media = media;
		this.name = name;
	}
}

function artifactSchema<M extends string>(media?: M): TUnsafe<ArtifactRef<M>> {
	return Type.Unsafe<ArtifactRef<M>>(
		Type.Object(
			{
				kind: Type.Literal("artifact"),
				digest: Type.String({ pattern: DIGEST }),
				name: Type.String({ minLength: 1 }),
				media: media === undefined ? Type.String() : Type.Literal(media),
				path: Type.Optional(Type.String()),
			},
			{ additionalProperties: false, [MARK]: "artifact" },
		),
	);
}

export const Artifact: {
	<const M extends string = string>(media?: M): TUnsafe<ArtifactRef<M>>;
	/** Caller only: a host file, ingested into the store when the run starts. */
	from<const M extends string = string>(hostPath: string, options?: { media?: M; name?: string }): ArtifactRef<M>;
} = Object.assign(artifactSchema, {
	from<const M extends string = string>(hostPath: string, options: { media?: M; name?: string } = {}): ArtifactRef<M> {
		// A marker typed as the ref it becomes: `run` replaces it before anything is journaled.
		return new HostPath("artifact", hostPath, options.media, options.name) as unknown as ArtifactRef<M>;
	},
});

export const Tree: {
	(): TUnsafe<TreeRef>;
	/** Caller only: a host directory, snapshotted into the store when the run starts (incremental, reflinked). */
	from(hostPath: string): TreeRef;
} = Object.assign(
	(): TUnsafe<TreeRef> =>
		Type.Unsafe<TreeRef>(Type.Object({ kind: Type.Literal("tree"), digest: Type.String({ pattern: DIGEST }), path: Type.Optional(Type.String()) }, { additionalProperties: false, [MARK]: "tree" })),
	{
		from(hostPath: string): TreeRef {
			return new HostPath("tree", hostPath) as unknown as TreeRef;
		},
	},
);

/**
 * An address whose messages match `message`. As an agent input field, it gives the agent a `send`
 * tool whose parameters are `message`. Passing an address whose recipient's mailbox schema differs
 * from `message` fails the call before the agent starts (schema digests must be equal).
 */
export function Address<S extends TSchema>(message: S): TUnsafe<Address<Static<S>>> {
	return Type.Unsafe<Address<Static<S>>>(Type.Object({ kind: Type.Literal("address"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false, [MARK]: "address", message }));
}

// --- Canonical JSON and schema digests -------------------------------------------

/** Canonical JSON: sorted keys, no whitespace. */
export function canonical(value: unknown): string {
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(walk);
		if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().flatMap((k) => ((v as Record<string, unknown>)[k] === undefined ? [] : [[k, walk((v as Record<string, unknown>)[k])]])));
		return v;
	};
	return JSON.stringify(walk(value));
}

export const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** A schema's identity: its canonical JSON's digest. */
export function schemaDigest(schema: unknown): string {
	return sha256(canonical(schema));
}

// --- Refs in values ---------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export function isArtifactRef(v: unknown): v is { kind: "artifact"; digest: string; name: string; media: string; path?: string } {
	return isObj(v) && v.kind === "artifact" && typeof v.digest === "string" && DIGEST_RE.test(v.digest) && typeof v.name === "string" && typeof v.media === "string";
}

export function isTreeRef(v: unknown): v is { kind: "tree"; digest: string; path?: string } {
	return isObj(v) && v.kind === "tree" && typeof v.digest === "string" && DIGEST_RE.test(v.digest);
}

/** Maps every artifact ref and Tree ref in a value (by shape). */
export function mapRefs(value: unknown, f: (ref: Obj & { kind: "artifact" | "tree" }) => unknown): unknown {
	if (isArtifactRef(value) || isTreeRef(value)) return f(value as Obj & { kind: "artifact" | "tree" });
	if (Array.isArray(value)) return value.map((v) => mapRefs(v, f));
	if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapRefs(v, f)]));
	return value;
}

/** Every ref in a value, without duplicates (by kind and digest and name). */
export function refsIn(value: unknown): (Obj & { kind: "artifact" | "tree"; digest: string })[] {
	const found = new Map<string, Obj & { kind: "artifact" | "tree"; digest: string }>();
	mapRefs(value, (r) => {
		found.set(`${r.kind}:${r.digest}:${String(r.name ?? "")}`, r as Obj & { kind: "artifact" | "tree"; digest: string });
		return r;
	});
	return [...found.values()];
}

/** The value as the journal keeps it: refs without `path`. */
export function stripPaths(value: unknown): Json {
	return mapRefs(value, (r) => {
		const { path: _path, ...rest } = r;
		return rest;
	}) as Json;
}

/** The value with each ref's `path` set by `where`. */
export function withPaths(value: unknown, where: (ref: Obj & { kind: "artifact" | "tree"; digest: string; name?: string }) => string): unknown {
	return mapRefs(value, (r) => ({ ...r, path: where(r as Obj & { kind: "artifact" | "tree"; digest: string }) }));
}

/** A plain JSON copy of `value`, or the reason it is not JSON (functions, class instances, non-finite numbers). */
export function toJson(value: unknown, path = ""): { ok: true; value: Json } | { ok: false; error: string } {
	if (value === null || typeof value === "boolean" || typeof value === "string") return { ok: true, value };
	if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false, error: `${path || "/"} is not a finite number` };
	if (Array.isArray(value)) {
		const out: Json[] = [];
		for (const [i, v] of value.entries()) {
			const r = toJson(v, `${path}/${i}`);
			if (!r.ok) return r;
			out.push(r.value);
		}
		return { ok: true, value: out };
	}
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return { ok: false, error: `${path || "/"} is not plain data (${(value as object).constructor?.name ?? "object"})` };
		const out: Record<string, Json> = {};
		for (const [k, v] of Object.entries(value)) {
			if (v === undefined) continue;
			const r = toJson(v, `${path}/${k}`);
			if (!r.ok) return r;
			out[k] = r.value;
		}
		return { ok: true, value: out };
	}
	return { ok: false, error: `${path || "/"} is not JSON (${typeof value})` };
}

/** Validation errors of a value against a schema, as `{ path, message }` (empty when it matches). */
export function schemaErrors(schema: TSchema, value: unknown): { path: string; message: string }[] {
	if (Value.Check(schema, value)) return [];
	const errors = [...Value.Errors(schema, value)].map((e) => ({ path: e.instancePath || "/", message: e.message }));
	return errors.length > 0 ? errors.slice(0, 12) : [{ path: "/", message: "does not match" }];
}

export const errorText = (errors: readonly { path: string; message: string }[]): string[] => errors.map((e) => `${e.path} ${e.message}`);

// --- Schema-guided walks ----------------------------------------------------------

/**
 * Calls `at` for every position in `value` where `schema` declares a wallis
 * value (artifact, tree, address), with that schema node. Follows
 * properties, items, tuples, records (patternProperties/additionalProperties)
 * and unions (each member whose shape the value fits).
 */
export function walkMarked(schema: unknown, value: unknown, at: (mark: string, node: Obj, value: unknown, path: string) => unknown, path = ""): unknown {
	if (!isObj(schema)) return value;
	const mark = schema[MARK];
	if (typeof mark === "string") return at(mark, schema, value, path);
	if (Array.isArray(schema.anyOf)) {
		for (const member of schema.anyOf) {
			// The first member that has a mark somewhere and that the value plausibly fits.
			const out = walkMarked(member, value, at, path);
			if (out !== value) return out;
		}
		return value;
	}
	if (Array.isArray(value)) {
		if (Array.isArray(schema.prefixItems)) return value.map((v, i) => walkMarked((schema.prefixItems as unknown[])[i] ?? schema.items, v, at, `${path}/${i}`));
		if (schema.items !== undefined) return value.map((v, i) => walkMarked(schema.items, v, at, `${path}/${i}`));
		return value;
	}
	if (isObj(value)) {
		const props = isObj(schema.properties) ? schema.properties : {};
		const pattern = isObj(schema.patternProperties) ? Object.values(schema.patternProperties)[0] : undefined;
		const extra = isObj(schema.additionalProperties) ? schema.additionalProperties : pattern;
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walkMarked(props[k] ?? extra, v, at, `${path}/${k}`)]));
	}
	return value;
}

/** Every address in a value at a position its schema declares one, with its message schema. */
export function addressesIn(schema: unknown, value: unknown): { path: string; id: string; message: TSchema }[] {
	const out: { path: string; id: string; message: TSchema }[] = [];
	walkMarked(schema, value, (mark, node, v, path) => {
		if (mark === "address" && isObj(v) && typeof v.id === "string") out.push({ path, id: v.id, message: node.message as TSchema });
		return v;
	});
	return out;
}

/** Whether a schema declares any artifact or Tree position. */
export function hasFiles(schema: unknown): boolean {
	let found = false;
	const walk = (s: unknown) => {
		if (found || !isObj(s)) return;
		if (s[MARK] === "artifact" || s[MARK] === "tree") {
			found = true;
			return;
		}
		for (const v of Object.values(s)) {
			if (Array.isArray(v)) v.forEach(walk);
			else walk(v);
		}
	};
	walk(schema);
	return found;
}

/** The media an artifact position declares (`Artifact("image/jpeg")`), if any. */
export function declaredMedia(node: Obj): string | undefined {
	const props = isObj(node.properties) ? node.properties : {};
	const media = props.media;
	return isObj(media) && typeof media.const === "string" ? media.const : undefined;
}

const MEDIA: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	tif: "image/tiff",
	tiff: "image/tiff",
	json: "application/json",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	pdf: "application/pdf",
};

/** A media type from a file name's extension (`application/octet-stream` when unknown). */
export function guessMedia(name: string): string {
	const ext = name.toLowerCase().split(".").pop() ?? "";
	return MEDIA[ext] ?? "application/octet-stream";
}
