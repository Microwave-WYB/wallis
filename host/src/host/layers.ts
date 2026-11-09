// Workspace layers. A session value's `/w` is an overlay of immutable
// layers (bottom first) with the call's own upper dir on top. In a bwrap
// sandbox it is the kernel's overlay (`--overlay-src … --overlay upper work
// /w`); the host's own file tools resolve paths the same way here.
//
//   <run>/layers/<hex>/        a layer: the files a call changed, whiteouts
//                              (0:0 character devices) for what it deleted,
//                              and directories marked opaque (xattr
//                              user.overlay.opaque) where it replaced one
//   <run>/layers/<hex>.json    its manifest: every entry, with each file's
//                              sha256; <hex> is the manifest's sha256
//   <run>/work/<node>/upper/   the call's changes while it runs
//
// After a call its upper dir becomes a layer: only the changed files are
// hashed, and the dir is renamed into the store, so nothing is copied. The
// manifest and the dir are written before the event that names the layer.
// Beyond MAX_DEPTH layers the stack is squashed into one: files are
// hardlinked and manifests merged, so an unchanged file is never copied or
// hashed again.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crashPoint } from "./artifacts.ts";

export const MAX_DEPTH = 16;

/** One entry of a layer. `whiteout`: deleted here; an `opaque` dir hides the layers below it. */
export type Entry =
	| { readonly type: "file"; readonly sha256: string; readonly mode: number; readonly size: number }
	| { readonly type: "dir"; readonly opaque: boolean }
	| { readonly type: "symlink"; readonly target: string }
	| { readonly type: "whiteout" };

/** A layer's manifest: its entries by path (relative, `/`-separated), sorted. */
export type Manifest = Readonly<Record<string, Entry>>;

/** A call's workspace: its layers (dirs, bottom first), its upper dir, and overlayfs's work dir. */
export interface Work {
	readonly lowers: readonly string[];
	readonly upper: string;
	readonly ovl: string;
}

export function layersDir(runDir: string): string {
	return join(runDir, "layers");
}

export function layerDir(runDir: string, digest: string): string {
	return join(layersDir(runDir), digest.slice("sha256:".length));
}

export function readManifest(runDir: string, digest: string): Manifest {
	return JSON.parse(readFileSync(`${layerDir(runDir, digest)}.json`, "utf8")) as Manifest;
}

/** The call's workspace dirs for these layers (each must be in the store). */
export function prepareWork(runDir: string, root: string, layers: readonly string[]): Work | { readonly missing: string } {
	for (const l of layers) if (!existsSync(layerDir(runDir, l)) || !existsSync(`${layerDir(runDir, l)}.json`)) return { missing: l };
	const work: Work = { lowers: layers.map((l) => layerDir(runDir, l)), upper: join(root, "upper"), ovl: join(root, "ovl") };
	// The call's changes were committed as a layer, but the event naming it was not logged (the
	// host died in between): the reissued call continues with them, copied (never linked: the
	// layer is immutable).
	const committed = join(root, "committed");
	if (!existsSync(work.upper) && existsSync(committed)) {
		const from = layerDir(runDir, readFileSync(committed, "utf8").trim());
		if (existsSync(from)) spawnSync("cp", ["-a", "--reflink=auto", from, work.upper]);
		rmSync(committed, { force: true });
	}
	mkdirSync(work.upper, { recursive: true });
	mkdirSync(work.ovl, { recursive: true });
	return work;
}

/** Removes a call's dirs; overlayfs leaves `ovl/work` with mode 000, so it is opened first. */
export function removeWork(root: string): void {
	const inner = join(root, "ovl", "work");
	if (existsSync(inner)) chmodSync(inner, 0o700);
	rmSync(root, { recursive: true, force: true });
}

/** Paths under `dir` marked opaque by overlayfs (xattr user.overlay.opaque = y), relative to it. */
function opaqueDirs(dir: string): Set<string> {
	const dump = spawnSync("getfattr", ["-R", "--absolute-names", "-d", "-m", "^user\\.overlay\\.opaque$", dir], { encoding: "utf8" });
	const found = new Set<string>();
	let current: string | null = null;
	for (const line of dump.stdout.split("\n")) {
		if (line.startsWith("# file: ")) current = line.slice("# file: ".length);
		else if (current !== null && line === 'user.overlay.opaque="y"') found.add(current.slice(dir.length + 1));
	}
	return found;
}

/** Whether this one dir is marked opaque. */
function opaque(dir: string): boolean {
	const r = spawnSync("getfattr", ["--only-values", "-n", "user.overlay.opaque", dir], { encoding: "utf8" });
	return r.status === 0 && r.stdout === "y";
}

/** The manifest of an upper dir: only what the call changed is there, so only that is hashed. */
function manifestOf(upper: string): Manifest {
	const entries: Record<string, Entry> = {};
	const opaque = opaqueDirs(upper);
	const walk = (rel: string) => {
		for (const name of readdirSync(join(upper, rel)).sort()) {
			const path = rel === "" ? name : `${rel}/${name}`;
			const st = lstatSync(join(upper, path));
			if (st.isCharacterDevice() && st.rdev === 0) entries[path] = { type: "whiteout" };
			else if (st.isSymbolicLink()) entries[path] = { type: "symlink", target: readlinkSync(join(upper, path)) };
			else if (st.isDirectory()) {
				entries[path] = { type: "dir", opaque: opaque.has(path) };
				walk(path);
			} else if (st.isFile()) entries[path] = { type: "file", sha256: createHash("sha256").update(readFileSync(join(upper, path))).digest("hex"), mode: st.mode & 0o777, size: st.size };
		}
	};
	walk("");
	return entries;
}

function digestOf(manifest: Manifest): { digest: string; text: string } {
	const text = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]])));
	return { digest: `sha256:${createHash("sha256").update(text).digest("hex")}`, text };
}

/**
 * Turns a finished call's upper dir into a layer: its manifest, then the
 * dir renamed into the store (or dropped, if the store has that layer).
 * Null when the call changed nothing.
 */
export function commitLayer(runDir: string, work: Work, root: string): string | null {
	if (!existsSync(work.upper)) return null;
	const manifest = manifestOf(work.upper);
	if (Object.keys(manifest).length === 0) return null;
	const { digest, text } = digestOf(manifest);
	const dir = layerDir(runDir, digest);
	mkdirSync(layersDir(runDir), { recursive: true });
	if (!existsSync(`${dir}.json`)) {
		writeFileSync(`${dir}.json.${process.pid}.tmp`, text);
		renameSync(`${dir}.json.${process.pid}.tmp`, `${dir}.json`);
	}
	// Named in the call's dir first: a host that dies before the event restores the upper dir from it.
	writeFileSync(join(root, "committed"), digest);
	if (existsSync(dir)) rmSync(work.upper, { recursive: true, force: true });
	else renameSync(work.upper, dir);
	crashPoint("layer");
	return digest;
}

/** One layer for a stack of them: files hardlinked, manifests merged; nothing is copied or hashed again. */
export function squash(runDir: string, layers: readonly string[]): string {
	const merged = new Map<string, { entry: Entry; from: string }>();
	for (const layer of layers) {
		const manifest = readManifest(runDir, layer);
		for (const path of Object.keys(manifest).sort()) {
			const entry = manifest[path]!;
			const under = (p: string) => p.startsWith(`${path}/`);
			if (entry.type === "whiteout" || (entry.type === "dir" && entry.opaque)) for (const p of [...merged.keys()]) if (under(p)) merged.delete(p);
			if (entry.type === "whiteout") merged.delete(path);
			else merged.set(path, { entry: entry.type === "dir" ? { type: "dir", opaque: false } : entry, from: layer });
		}
	}
	const manifest: Manifest = Object.fromEntries([...merged].map(([p, v]) => [p, v.entry]));
	const { digest, text } = digestOf(manifest);
	const dir = layerDir(runDir, digest);
	if (existsSync(dir)) return digest;
	const temp = `${dir}.${process.pid}.tmp`;
	rmSync(temp, { recursive: true, force: true });
	mkdirSync(temp, { recursive: true });
	for (const [path, { entry, from }] of [...merged].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const target = join(temp, path);
		mkdirSync(dirname(target), { recursive: true });
		if (entry.type === "dir") mkdirSync(target, { recursive: true });
		else if (entry.type === "symlink") symlinkSync(entry.target, target);
		else if (entry.type === "file") linkSync(join(layerDir(runDir, from), path), target);
	}
	writeFileSync(`${dir}.json`, text);
	renameSync(temp, dir);
	return digest;
}

/** The session's layers after a call: its new layer on top, squashed into one beyond MAX_DEPTH. */
export function layersAfter(runDir: string, before: readonly string[], committed: string | null): string[] {
	const after = committed === null ? [...before] : [...before, committed];
	return after.length > MAX_DEPTH ? [squash(runDir, after)] : after;
}

/** What a workspace path is, through the upper dir and the layers below it (as overlayfs resolves it). */
export function resolveIn(work: Work, rel: string): { readonly path: string; readonly writable: boolean } | null {
	const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
	const stack = [work.upper, ...[...work.lowers].reverse()];
	for (let i = 0; i < stack.length; i++) {
		const root = stack[i]!;
		const path = join(root, ...parts);
		if (!existsSync(path) && !isWhiteout(path)) {
			// An opaque dir or a whiteout above the path hides the layers below.
			if (hidden(root, parts)) return null;
			continue;
		}
		if (isWhiteout(path)) return null;
		return { path, writable: i === 0 };
	}
	return null;
}

function isWhiteout(path: string): boolean {
	try {
		const st = lstatSync(path);
		return st.isCharacterDevice() && st.rdev === 0;
	} catch {
		return false;
	}
}

/** Whether a parent of `parts` in this layer is a whiteout or an opaque dir (so lower layers are hidden). */
function hidden(root: string, parts: readonly string[]): boolean {
	for (let n = 1; n < parts.length; n++) {
		const p = join(root, ...parts.slice(0, n));
		if (isWhiteout(p)) return true;
		if (existsSync(p) && opaque(p)) return true;
	}
	return false;
}

/** A merged directory listing through the layers (names, sorted). */
export function listIn(work: Work, rel: string): string[] | null {
	const names = new Map<string, boolean>();
	let found = false;
	for (const root of [work.upper, ...[...work.lowers].reverse()]) {
		const dir = join(root, ...rel.split("/").filter((p) => p !== ""));
		if (!existsSync(dir)) continue;
		if (!lstatSync(dir).isDirectory()) break;
		found = true;
		for (const name of readdirSync(dir)) if (!names.has(name)) names.set(name, !isWhiteout(join(dir, name)));
		if (opaque(dir)) break;
	}
	return found ? [...names].filter(([, live]) => live).map(([n]) => n).sort() : null;
}
