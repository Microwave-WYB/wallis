// The run's content-addressed blob store and per-node directories.
//
//   .wallis/runs/<id>/blobs/<sha256 hex>        one file per distinct content: artifacts,
//                                                and values events refer to (dialogues)
//   .wallis/runs/<id>/work/<node>/inputs/<hex>/<name>   read-only input artifacts
//   .wallis/runs/<id>/work/<node>/scratch/      the call's private writable dir (/w in its sandbox)
//
// Journal and replay carry refs only. A node's dir lives while the node is
// running or idle and is deleted when it is done; files it did not export
// as artifacts are discarded. No directory is shared between nodes.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ArtifactDraft, ArtifactRef, Json } from "../sdk/index.ts";
import type { ResolvedVolume } from "./volumes.ts";
import { layerDir, type Located, locate, openViewFile, prepareWork, removeWork, syncPath, ViewError, type Work, workRoot } from "./layers.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isRef(value: unknown): value is ArtifactRef {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return typeof v.digest === "string" && DIGEST.test(v.digest) && typeof v.name === "string" && typeof v.media === "string" && Object.keys(v).length === 3;
}

function isDraft(value: unknown): value is ArtifactDraft {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return typeof v.artifact === "string" && typeof v.media === "string" && Object.keys(v).every((k) => k === "artifact" || k === "media" || k === "name");
}

/** Every artifact ref in a JSON value, in order, without duplicates. */
export function refsIn(value: Json): ArtifactRef[] {
	const found = new Map<string, ArtifactRef>();
	const walk = (v: Json) => {
		if (isRef(v)) found.set(`${v.digest}/${v.name}`, v);
		else if (Array.isArray(v)) v.forEach(walk);
		else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
	};
	walk(value);
	return [...found.values()];
}

export function blobsDir(runDir: string): string {
	return join(runDir, "blobs");
}

export function blobPath(runDir: string, digest: string): string {
	return join(blobsDir(runDir), digest.slice("sha256:".length));
}

/** Copies a file into the store (once per content) and returns its ref. */
export function storeFile(runDir: string, path: string, media: string, name = basename(path)): ArtifactRef {
	const digest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
	const target = blobPath(runDir, digest);
	if (!existsSync(target)) {
		mkdirSync(blobsDir(runDir), { recursive: true });
		copyFileSync(path, target);
		chmodSync(target, 0o444);
	}
	return { digest, name, media };
}

/**
 * Stores an open file's content (read once, through the fd: never by a
 * path an agent could swap) and returns its ref. The caller closes the fd.
 */
export function storeFd(runDir: string, fd: number, media: string, name: string): ArtifactRef {
	mkdirSync(blobsDir(runDir), { recursive: true });
	const temp = join(blobsDir(runDir), `.in-${process.pid}-${Math.random().toString(36).slice(2)}`);
	const out = openSync(temp, "wx", 0o600);
	const hash = createHash("sha256");
	try {
		const chunk = Buffer.alloc(1 << 20);
		for (;;) {
			const n = readSync(fd, chunk, 0, chunk.length, null);
			if (n === 0) break;
			hash.update(chunk.subarray(0, n));
			writeSync(out, chunk, 0, n);
		}
	} finally {
		closeSync(out);
	}
	const digest = `sha256:${hash.digest("hex")}`;
	const target = blobPath(runDir, digest);
	if (existsSync(target)) rmSync(temp, { force: true });
	else {
		chmodSync(temp, 0o444);
		renameSync(temp, target);
	}
	return { digest, name, media };
}

/**
 * Writes a value the log will refer to (a dialogue, a layer manifest) as a
 * blob, before the event that names its digest: written to a temp file and
 * renamed, so a blob is whole or absent. Returns its digest.
 */
export function putBlob(runDir: string, text: string): string {
	const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
	const target = blobPath(runDir, digest);
	if (!existsSync(target)) {
		mkdirSync(blobsDir(runDir), { recursive: true });
		const temp = `${target}.${process.pid}.tmp`;
		writeFileSync(temp, text);
		chmodSync(temp, 0o444);
		syncPath(temp);
		renameSync(temp, target);
		syncPath(blobsDir(runDir));
		crashPoint("blob");
	}
	return digest;
}

/** A blob's text, or null when the store does not have it. */
export function readBlob(runDir: string, digest: string): string | null {
	if (!DIGEST.test(digest)) return null;
	const path = blobPath(runDir, digest);
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Fault injection for crash tests: `WALLIS_CRASH_AT=<point>:<n>` kills this
 * process (SIGKILL) at the nth time it reaches `point`, e.g. right after a
 * blob is written and before the event that names it.
 */
const crashes = new Map<string, number>();
export function crashPoint(point: string): void {
	const at = process.env.WALLIS_CRASH_AT;
	if (!at) return;
	const [name, n] = at.split(":");
	if (name !== point) return;
	const count = (crashes.get(point) ?? 0) + 1;
	crashes.set(point, count);
	if (count === Number(n)) process.kill(process.pid, "SIGKILL");
}

export class ArtifactError extends Error {
	override readonly name = "ArtifactError";
	/** Set when a draft names a file that is not in the scratch dir. */
	readonly missing: string | undefined;
	constructor(message: string, missing?: string) {
		super(message);
		this.missing = missing;
	}
}

/**
 * Replaces artifact drafts (`{ artifact: "<path in scratch>", media }`) with
 * refs, storing the files. A draft must name a regular file inside the
 * node's scratch dir.
 */
export function resolveDrafts(value: Json, runDir: string, scratch: string | Work | null): Json {
	if (isDraft(value)) {
		if (!scratch) throw new ArtifactError(`artifact ${value.artifact}: this node has no scratch dir`);
		const base = typeof scratch === "string" ? scratch : scratch.upper;
		const rel = relative(base, resolve(base, value.artifact));
		if (rel.startsWith("..") || rel.startsWith(sep) || rel === "") throw new ArtifactError(`artifact ${value.artifact} is outside the node's scratch dir`);
		// Resolved in the sandbox view (an agent's file may be in any of its session's layers), never
		// through a host symlink: a link out of /w is refused.
		const root = typeof scratch === "string" ? { at: "/w", stack: [scratch], upper: scratch } : workRoot(scratch);
		let located: Located;
		try {
			located = locate([root], `/w/${rel}`, true);
		} catch (error) {
			if (!(error instanceof ViewError)) throw error;
			throw new ArtifactError(`artifact ${value.artifact}: ${error.message}`);
		}
		const entry = located.entry;
		if (entry === null || entry.kind !== "file") throw new ArtifactError(`artifact ${value.artifact} is not a file in the node's scratch dir`, value.artifact);
		// Read through an fd opened beneath its layer dir, never following a link (see openBeneath).
		let fd: number;
		try {
			fd = openViewFile(located, `/w/${rel}`);
		} catch (error) {
			if (!(error instanceof ViewError)) throw error;
			throw new ArtifactError(`artifact ${value.artifact}: ${error.message}`);
		}
		try {
			return storeFd(runDir, fd, value.media, value.name ?? basename(entry.host)) as unknown as Json;
		} finally {
			closeSync(fd);
		}
	}
	if (Array.isArray(value)) return value.map((v) => resolveDrafts(v, runDir, scratch));
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDrafts(v, runDir, scratch)]));
	return value;
}

/** Every artifact ref in a value must name a blob in the run's store. */
export function verifyRefs(value: Json, runDir: string): void {
	for (const ref of refsIn(value)) {
		if (!existsSync(blobPath(runDir, ref.digest))) throw new ArtifactError(`artifact ${ref.name} (${ref.digest}) is not in the run's store`);
	}
}

/** Hardlinks a blob to `target` (same filesystem) or copies it. */
export function linkOrCopy(source: string, target: string): void {
	try {
		linkSync(source, target);
	} catch {
		copyFileSync(source, target);
		chmodSync(target, 0o444);
	}
}

// --- Node directories ------------------------------------------------------------

export interface NodeDirs {
	readonly root: string;
	/** `<inputs>/<sha256 hex>/<name>` for every artifact in the node's input. */
	readonly inputs: string;
	/** Where writes to `/w` land: a command's private dir, or an agent call's upper dir. */
	readonly scratch: string;
	/** An agent call's workspace: its session's layers under `scratch` (null for a command). */
	readonly work: Work | null;
	/** Every Tree in the input, read-only at `/in/trees/<hex>`: its layers, bottom first. */
	readonly trees: readonly { readonly at: string; readonly lowers: readonly string[] }[];
	/** The sandbox's volumes: bind volumes read-only, named volumes writable. */
	readonly volumes: readonly ResolvedVolume[];
	/** Host-owned: where capped tool and codemode output spills. Not a tool-visible dir. */
	readonly spill: string;
}

/**
 * A node's dir name: its id, one-to-one, in file-name characters. `#`
 * becomes `_` (so `#0.a#1` reads `_0.a_1`); `-` escapes the rest (`--`,
 * `-u` for `_`, `-<hex>-` for any other character), so two ids never share
 * a dir.
 */
export function nodeDirName(id: string): string {
	const name = id.replace(/[^A-Za-z0-9.]/g, (c) => (c === "#" ? "_" : c === "-" ? "--" : c === "_" ? "-u" : `-${c.codePointAt(0)!.toString(16)}-`));
	return name === "" || name === "." || name === ".." ? `-${name}` : name;
}

/** Where a node's input artifact is mounted. */
export function inputPath(dirs: NodeDirs, ref: ArtifactRef): string {
	return join(dirs.inputs, ref.digest.slice("sha256:".length), ref.name);
}

/**
 * Creates (or reuses, for a continued node) a node's dirs and links its
 * input artifacts. An agent call's scratch dir is its session's (`scratch`),
 * which outlives the call.
 */
export function prepareNode(runDir: string, id: string, input: Json, schema: unknown, volumes: readonly ResolvedVolume[], layers: readonly string[] | null = null, attempt = 1): NodeDirs {
	const root = join(runDir, "work", nodeDirName(id));
	verifyRefs(input, runDir);
	let work: Work | null = null;
	if (layers !== null) {
		const prepared = prepareWork(runDir, root, layers, attempt);
		if ("missing" in prepared) throw new ArtifactError(`layer ${prepared.missing} of the session's workspace is not in the store`);
		work = prepared;
	}
	const trees = treesIn(input, schema).map((t) => {
		for (const l of t.layers) if (!existsSync(layerDir(runDir, l))) throw new ArtifactError(`layer ${l} of a tree in the input is not in the store`);
		return { at: treePath(t), lowers: t.layers.map((l) => layerDir(runDir, l)) };
	});
	const dirs: NodeDirs = { root, inputs: join(root, "inputs"), scratch: work?.upper ?? join(root, "scratch"), work, trees, volumes, spill: join(root, "spill") };
	// Mount points inside the read-only /in exist before the sandbox starts.
	for (const t of trees) mkdirSync(join(dirs.inputs, t.at.slice(`${"/in"}/`.length)), { recursive: true });
	mkdirSync(dirs.inputs, { recursive: true });
	mkdirSync(dirs.scratch, { recursive: true });
	for (const ref of refsIn(input)) {
		const blob = blobPath(runDir, ref.digest);
		const target = inputPath(dirs, ref);
		if (existsSync(target)) continue;
		mkdirSync(join(target, ".."), { recursive: true });
		linkOrCopy(blob, target);
	}
	return dirs;
}

/** A Tree value: a session's workspace, as its layers (see `ctx.files`). */
export type TreeRef = { readonly kind: "tree"; readonly layers: readonly string[] };

export function isTree(value: unknown): value is TreeRef {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return v.kind === "tree" && Array.isArray(v.layers) && v.layers.every((l) => typeof l === "string" && DIGEST.test(l));
}

/**
 * Every Tree in a value at a position its schema declares one (`TreeValue()`,
 * marked `wallis: "tree"`): JSON shaped like a Tree anywhere else is data,
 * never mounted.
 */
export function treesIn(value: Json, schema: unknown): TreeRef[] {
	const found = new Set<TreeRef>();
	const walk = (s: unknown, v: Json) => {
		if (s === null || typeof s !== "object") return;
		const node = s as { wallis?: unknown; anyOf?: unknown[]; type?: unknown; properties?: Record<string, unknown>; items?: unknown };
		if (node.wallis === "tree") {
			if (isTree(v)) found.add(v);
			return;
		}
		for (const member of node.anyOf ?? []) walk(member, v);
		if (node.properties && v !== null && typeof v === "object" && !Array.isArray(v)) for (const [k, p] of Object.entries(node.properties)) walk(p, (v as Record<string, Json>)[k] ?? null);
		if (node.items && Array.isArray(v)) for (const item of v) walk(node.items, item);
	};
	walk(schema, value);
	return [...found];
}

/** Where a Tree is mounted inside a sandbox: `/in/trees/<hex of its layers>`. */
export function treePath(tree: TreeRef): string {
	return `/in/trees/${createHash("sha256").update(tree.layers.join("\n")).digest("hex").slice(0, 16)}`;
}

/** The input as a command's `run` sees it: every artifact ref, and every Tree its schema declares, with its `path` inside the sandbox. */
export function mountedInput(value: Json, inputsAt: string, schema: unknown): Json {
	const trees = new Set<unknown>(treesIn(value, schema));
	const walk = (v: Json): Json => {
		if (isTree(v) && trees.has(v)) return { kind: "tree", layers: [...v.layers], path: treePath(v) };
		if (isRef(v)) return { ...v, path: `${inputsAt}/${v.digest.slice("sha256:".length)}/${v.name}` };
		if (Array.isArray(v)) return v.map(walk);
		if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	return walk(value);
}

/** Deletes a done node's dirs: what it did not export (or commit as a layer) is discarded. */
export function discardNode(runDir: string, id: string): void {
	removeWork(join(runDir, "work", nodeDirName(id)));
}

/** Shares the blobs of one run with another (fork): hardlinks, else copies. */
export function shareBlobs(fromRunDir: string, toRunDir: string): void {
	const from = blobsDir(fromRunDir);
	if (!existsSync(from)) return;
	mkdirSync(blobsDir(toRunDir), { recursive: true });
	for (const file of readdirSync(from)) {
		const target = join(blobsDir(toRunDir), file);
		if (!existsSync(target)) linkOrCopy(join(from, file), target);
	}
}
