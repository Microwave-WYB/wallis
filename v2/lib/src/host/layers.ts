// Layers: the immutable directories Trees and workspaces are made of. A
// Tree is a stack of layers (bottom first); a session value's `/w` is an
// overlay of its layers with the call's own upper dir on top, the kernel's
// overlay in a bwrap sandbox (`--overlay-src … --overlay upper work /w`).
//
//   <store>/layers/<hex>/      a layer: the files a call changed, whiteouts
//                              (0:0 character devices) for what it deleted,
//                              and directories marked opaque (xattr
//                              user.overlay.opaque) where it replaced one
//   <store>/layers/<hex>.json  its manifest: every entry, with each file's
//                              sha256; <hex> is the manifest's sha256
//   <call dir>/upper/          the call's changes while it runs
//
// The store is the project's (`.wallis/store`), shared by all its runs.
//
// After a call its upper dir becomes a layer: only the changed files are
// hashed, and the dir is renamed into the store, so nothing is copied. The
// manifest and the dir are written before the event that names the layer.
// Beyond MAX_DEPTH layers the stack is squashed into one: files are
// hardlinked and manifests merged, so an unchanged file is never copied or
// hashed again.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Type from "typebox";
import Value from "typebox/value";
import { crashPoint } from "./faults.ts";

export const MAX_DEPTH = 16;

/** One entry of a layer. `whiteout`: deleted here; an `opaque` dir hides the layers below it. */
export type Entry =
	| { readonly type: "file"; readonly sha256: string; readonly mode: number; readonly size: number }
	| { readonly type: "dir"; readonly opaque: boolean; readonly mode: number }
	/** A FIFO, socket or device node: kept as it is (hardlinked in a squash). */
	| { readonly type: "special"; readonly mode: number }
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

export function layersDir(store: string): string {
	return join(store, "layers");
}

export function layerDir(store: string, digest: string): string {
	return join(layersDir(store), digest.slice("sha256:".length));
}

const ManifestShape = Type.Record(
	Type.String(),
	Type.Union([
		Type.Object({ type: Type.Literal("file"), sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }), mode: Type.Integer(), size: Type.Integer() }),
		Type.Object({ type: Type.Literal("dir"), opaque: Type.Boolean(), mode: Type.Integer() }),
		Type.Object({ type: Type.Literal("special"), mode: Type.Integer() }),
		Type.Object({ type: Type.Literal("symlink"), target: Type.String() }),
		Type.Object({ type: Type.Literal("whiteout") }),
	]),
);

/** A layer's manifest, checked against its shape when read back. */
export function readManifest(store: string, digest: string): Manifest {
	const raw: unknown = JSON.parse(readFileSync(`${layerDir(store, digest)}.json`, "utf8"));
	if (!Value.Check(ManifestShape, raw)) throw new Error(`layer ${digest}: its manifest is malformed`);
	return raw;
}

/** The call's workspace dirs for these layers (each must be in the store), for this attempt of the call. */
export function prepareWork(store: string, root: string, layers: readonly string[], attempt = 1): Work | { readonly missing: string } {
	for (const l of layers) if (!existsSync(layerDir(store, l)) || !existsSync(`${layerDir(store, l)}.json`)) return { missing: l };
	const work: Work = { lowers: layers.map((l) => layerDir(store, l)), upper: join(root, "upper"), ovl: join(root, "ovl") };
	// The call's changes were committed as a layer, but the event naming it was not logged (the
	// host died in between): the reissued call continues with them, copied (never linked: the
	// layer is immutable).
	// The marker names the layer and the attempt that committed it: only that attempt continues with
	// it, and then always from the layer (an upper dir left beside it is discarded). It is copied into
	// a temp dir first and renamed only once the copy succeeded.
	const committed = join(root, "committed");
	if (existsSync(committed)) {
		const [digest, of] = readFileSync(committed, "utf8").trim().split(" ");
		const from = layerDir(store, digest ?? "");
		if (Number(of) === attempt && existsSync(from)) {
			rmSync(work.upper, { recursive: true, force: true });
			const temp = `${work.upper}.restore`;
			rmSync(temp, { recursive: true, force: true });
			const r = spawnSync("cp", ["-a", "--reflink=auto", from, temp], { encoding: "utf8" });
			if (r.status !== 0) throw new Error(`cannot restore the call's changes from layer ${digest}: ${r.stderr.trim()}`);
			renameSync(temp, work.upper);
		}
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

/** The xattr tools overlay emulation needs (opaque dirs): a workspace is refused without them. */
export function xattrToolsMissing(): string | null {
	for (const tool of ["getfattr", "setfattr"]) if (spawnSync(tool, ["--version"], { stdio: "ignore" }).status !== 0) return tool;
	return null;
}

/** Whether this one dir is marked opaque (asked per dir, with its raw path: nothing is escaped). */
function opaque(dir: string): boolean {
	const r = spawnSync("getfattr", ["--absolute-names", "--only-values", "-n", "user.overlay.opaque", "--", dir]);
	return r.status === 0 && r.stdout.toString() === "y";
}

/**
 * The manifest of an upper dir: only what the call changed is there, so
 * only that is hashed. `hash` hashes one file (a cache may answer it).
 */
export function manifestOf(upper: string, hash: (path: string) => string = hashFile, overlay = true): Manifest {
	const entries: Record<string, Entry> = {};
	const walk = (rel: string) => {
		for (const name of readdirSync(join(upper, rel)).sort()) {
			const path = rel === "" ? name : `${rel}/${name}`;
			const st = lstatSync(join(upper, path));
			if (overlay && st.isCharacterDevice() && st.rdev === 0) entries[path] = { type: "whiteout" };
			else if (st.isSymbolicLink()) entries[path] = { type: "symlink", target: readlinkSync(join(upper, path)) };
			else if (st.isDirectory()) {
				entries[path] = { type: "dir", opaque: overlay && opaque(join(upper, path)), mode: st.mode & 0o7777 };
				walk(path);
			} else if (st.isFile()) entries[path] = { type: "file", sha256: hash(join(upper, path)), mode: st.mode & 0o777, size: st.size };
			// Nothing is dropped: FIFOs, sockets and devices are kept as they are.
			else entries[path] = { type: "special", mode: st.mode };
		}
	};
	walk("");
	return entries;
}

/** sha256 of a file's content, read in chunks (never whole into memory). */
export function hashFile(path: string): string {
	const hash = createHash("sha256");
	const fd = openSync(path, constants.O_RDONLY);
	try {
		const chunk = Buffer.alloc(1 << 20);
		for (;;) {
			const n = readSync(fd, chunk, 0, chunk.length, null);
			if (n === 0) break;
			hash.update(chunk.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

export function digestOf(manifest: Manifest): { digest: string; text: string } {
	const text = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]])));
	return { digest: `sha256:${createHash("sha256").update(text).digest("hex")}`, text };
}

/**
 * Turns a finished call's upper dir into a layer: its manifest, then the
 * dir renamed into the store (or dropped, if the store has that layer).
 * Null when the call changed nothing.
 */
export function commitLayer(store: string, work: Pick<Work, "upper">, root: string | null, attempt = 1, options: { readonly overlay?: boolean } = {}): string | null {
	if (!existsSync(work.upper)) return null;
	const manifest = manifestOf(work.upper, hashFile, options.overlay ?? true);
	if (Object.keys(manifest).length === 0) return null;
	const { digest, text } = digestOf(manifest);
	const dir = layerDir(store, digest);
	mkdirSync(layersDir(store), { recursive: true });
	if (!existsSync(`${dir}.json`)) writeDurably(`${dir}.json`, text);
	// Named in the call's dir first: a host that dies before the event restores the upper dir from it.
	if (root !== null) writeDurably(join(root, "committed"), `${digest} ${attempt}`);
	if (existsSync(dir)) rmSync(work.upper, { recursive: true, force: true });
	else {
		syncTree(work.upper);
		renameSync(work.upper, dir);
		syncPath(layersDir(store));
	}
	crashPoint("layer");
	return digest;
}

/** fsync of one file or dir. */
export function syncPath(path: string): void {
	const fd = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Every file and dir under `root` (and it) on disk; links and special files have nothing to sync. */
function syncTree(root: string): void {
	const walk = (path: string) => {
		const st = lstatSync(path);
		if (st.isDirectory()) {
			for (const name of readdirSync(path)) walk(join(path, name));
			syncPath(path);
		} else if (st.isFile()) syncPath(path);
	};
	walk(root);
}

/** A file written whole and durable: a temp file, fsynced, renamed, and its dir fsynced. */
export function writeDurably(path: string, text: string): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, text);
	syncPath(temp);
	renameSync(temp, path);
	syncPath(dirname(path));
}

/** One layer for a stack of them: files hardlinked, manifests merged; nothing is copied or hashed again. */
export function squash(store: string, layers: readonly string[]): string {
	const merged = new Map<string, { entry: Entry; from: string }>();
	for (const layer of layers) {
		const manifest = readManifest(store, layer);
		for (const path of Object.keys(manifest).sort()) {
			const entry = manifest[path]!;
			const under = (p: string) => p.startsWith(`${path}/`);
			// Anything but a merged dir replaces what the layers below had under its path: a whiteout,
			// an opaque dir, and a file or symlink over a dir (the kernel leaves no whiteout for those).
			if (entry.type !== "dir" || entry.opaque) for (const p of [...merged.keys()]) if (under(p)) merged.delete(p);
			if (entry.type === "whiteout") merged.delete(path);
			else merged.set(path, { entry: entry.type === "dir" ? { type: "dir", opaque: false, mode: entry.mode } : entry, from: layer });
		}
	}
	const manifest: Manifest = Object.fromEntries([...merged].map(([p, v]) => [p, v.entry]));
	const { digest, text } = digestOf(manifest);
	const dir = layerDir(store, digest);
	if (existsSync(dir)) return digest;
	const temp = `${dir}.${process.pid}.tmp`;
	rmSync(temp, { recursive: true, force: true });
	mkdirSync(temp, { recursive: true });
	for (const [path, { entry, from }] of [...merged].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const target = join(temp, path);
		mkdirSync(dirname(target), { recursive: true });
		if (entry.type === "dir") {
			mkdirSync(target, { recursive: true });
			chmodSync(target, entry.mode);
		} else if (entry.type === "symlink") symlinkSync(entry.target, target);
		else linkSync(join(layerDir(store, from), path), target);
	}
	syncTree(temp);
	writeDurably(`${dir}.json`, text);
	renameSync(temp, dir);
	syncPath(layersDir(store));
	return digest;
}

/** The session's layers after a call: its new layer on top, squashed into one beyond MAX_DEPTH. */
export function layersAfter(store: string, before: readonly string[], committed: string | null): string[] {
	const after = committed === null ? [...before] : [...before, committed];
	// One overlay may not name a dir twice: a layer already in the stack (content written back
	// to an earlier state) squashes it, like a deep one.
	const repeated = committed !== null && before.includes(committed);
	return after.length > MAX_DEPTH || repeated ? [squash(store, after)] : after;
}

