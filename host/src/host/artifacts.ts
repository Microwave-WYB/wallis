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
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ArtifactDraft, ArtifactRef, Json } from "../sdk/index.ts";

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
		renameSync(temp, target);
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
export function resolveDrafts(value: Json, runDir: string, scratch: string | null): Json {
	if (isDraft(value)) {
		if (!scratch) throw new ArtifactError(`artifact ${value.artifact}: this node has no scratch dir`);
		const path = resolve(scratch, value.artifact);
		const rel = relative(scratch, path);
		if (rel.startsWith("..") || rel.startsWith(sep) || rel === "") throw new ArtifactError(`artifact ${value.artifact} is outside the node's scratch dir`);
		if (!existsSync(path) || !lstatSync(path).isFile()) throw new ArtifactError(`artifact ${value.artifact} is not a file in the node's scratch dir`, value.artifact);
		return storeFile(runDir, path, value.media, value.name ?? basename(path)) as unknown as Json;
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
	/** The call's private writable dir: `/w` inside its sandbox. */
	readonly scratch: string;
	/** Mounts by name, read-only. */
	readonly mounts: Readonly<Record<string, string>>;
	/** Host-owned: where capped tool and codemode output spills. Not a tool-visible dir. */
	readonly spill: string;
}

export function nodeDirName(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
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
export function prepareNode(runDir: string, id: string, input: Json, mounts: Readonly<Record<string, string>>, scratch?: string): NodeDirs {
	const root = join(runDir, "work", nodeDirName(id));
	const dirs: NodeDirs = { root, inputs: join(root, "inputs"), scratch: scratch ?? join(root, "scratch"), mounts, spill: join(root, "spill") };
	verifyRefs(input, runDir);
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

/** The input as a command's `run` sees it: every artifact ref with its `path` inside the sandbox. */
export function mountedInput(value: Json, inputsAt: string): Json {
	if (isRef(value)) return { ...value, path: `${inputsAt}/${value.digest.slice("sha256:".length)}/${value.name}` };
	if (Array.isArray(value)) return value.map((v) => mountedInput(v, inputsAt));
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mountedInput(v, inputsAt)]));
	return value;
}

/** Deletes a done node's dirs: what it did not export is discarded. */
export function discardNode(runDir: string, id: string): void {
	rmSync(join(runDir, "work", nodeDirName(id)), { recursive: true, force: true });
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
