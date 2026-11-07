// The run's content-addressed blob store and per-node directories.
//
//   .wallis/runs/<id>/blobs/<sha256 hex>        one file per distinct content
//   .wallis/runs/<id>/work/<node>/inputs/<hex>/<name>   read-only input artifacts
//   .wallis/runs/<id>/work/<node>/scratch/      the node's writable dir (workspace level)
//
// Journal and replay carry refs only. A node's dir lives while the node is
// running or idle and is deleted when it is done; files it did not export
// as artifacts are discarded. No directory is shared between nodes.

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ArtifactDraft, ArtifactRef, Json, SandboxLevel } from "../sdk/index.ts";

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

export class ArtifactError extends Error {
	override readonly name = "ArtifactError";
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
		if (!existsSync(path) || !lstatSync(path).isFile()) throw new ArtifactError(`artifact ${value.artifact} is not a file in the node's scratch dir`);
		return storeFile(runDir, path, value.media, value.name ?? basename(path)) as unknown as Json;
	}
	if (Array.isArray(value)) return value.map((v) => resolveDrafts(v, runDir, scratch));
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDrafts(v, runDir, scratch)]));
	return value;
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
	readonly level: SandboxLevel;
	readonly root: string;
	/** `<inputs>/<sha256 hex>/<name>` for every artifact in the node's input. */
	readonly inputs: string;
	readonly scratch: string | null;
	/** Data dirs by name, mounted read-only. */
	readonly data: Readonly<Record<string, string>>;
}

export function nodeDirName(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

/** Where a node's input artifact is mounted. */
export function inputPath(dirs: NodeDirs, ref: ArtifactRef): string {
	return join(dirs.inputs, ref.digest.slice("sha256:".length), ref.name);
}

/** Creates (or reuses, for a continued node) a node's dirs and mounts its input artifacts. */
export function prepareNode(runDir: string, id: string, level: SandboxLevel, input: Json, data: Readonly<Record<string, string>>): NodeDirs {
	const root = join(runDir, "work", nodeDirName(id));
	const dirs: NodeDirs = { level, root, inputs: join(root, "inputs"), scratch: level === "workspace" ? join(root, "scratch") : null, data };
	if (level === "none") return dirs;
	mkdirSync(dirs.inputs, { recursive: true });
	if (dirs.scratch) mkdirSync(dirs.scratch, { recursive: true });
	for (const ref of refsIn(input)) {
		const blob = blobPath(runDir, ref.digest);
		if (!existsSync(blob)) throw new ArtifactError(`input artifact ${ref.name} (${ref.digest}) is not in the run's store`);
		const target = inputPath(dirs, ref);
		if (existsSync(target)) continue;
		mkdirSync(join(target, ".."), { recursive: true });
		linkOrCopy(blob, target);
	}
	return dirs;
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

// --- Datasets ----------------------------------------------------------------------

/**
 * A dataset dir's manifest digest: sha256 over the sorted relative paths,
 * sizes and modification times of its files. Datasets are mounted, never
 * copied, so this is what the pin records.
 */
export function manifestDigest(dir: string): string {
	const lines: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const path = join(d, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) {
				const st = statSync(path, { bigint: true });
				lines.push(`${relative(dir, path)}\t${st.size}\t${st.mtimeNs}`);
			}
		}
	};
	walk(dir);
	return `manifest:sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}
