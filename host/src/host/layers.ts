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
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import Type from "typebox";
import Value from "typebox/value";
import { crashPoint } from "./artifacts.ts";

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

export function layersDir(runDir: string): string {
	return join(runDir, "layers");
}

export function layerDir(runDir: string, digest: string): string {
	return join(layersDir(runDir), digest.slice("sha256:".length));
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
export function readManifest(runDir: string, digest: string): Manifest {
	const raw: unknown = JSON.parse(readFileSync(`${layerDir(runDir, digest)}.json`, "utf8"));
	if (!Value.Check(ManifestShape, raw)) throw new Error(`layer ${digest}: its manifest is malformed`);
	return raw;
}

/** The call's workspace dirs for these layers (each must be in the store), for this attempt of the call. */
export function prepareWork(runDir: string, root: string, layers: readonly string[], attempt = 1): Work | { readonly missing: string } {
	for (const l of layers) if (!existsSync(layerDir(runDir, l)) || !existsSync(`${layerDir(runDir, l)}.json`)) return { missing: l };
	const work: Work = { lowers: layers.map((l) => layerDir(runDir, l)), upper: join(root, "upper"), ovl: join(root, "ovl") };
	// The call's changes were committed as a layer, but the event naming it was not logged (the
	// host died in between): the reissued call continues with them, copied (never linked: the
	// layer is immutable).
	// The marker names the layer and the attempt that committed it: only that attempt continues with
	// it, and then always from the layer (an upper dir left beside it is discarded). It is copied into
	// a temp dir first and renamed only once the copy succeeded.
	const committed = join(root, "committed");
	if (existsSync(committed)) {
		const [digest, of] = readFileSync(committed, "utf8").trim().split(" ");
		const from = layerDir(runDir, digest ?? "");
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

/** The manifest of an upper dir: only what the call changed is there, so only that is hashed. */
function manifestOf(upper: string): Manifest {
	const entries: Record<string, Entry> = {};
	const walk = (rel: string) => {
		for (const name of readdirSync(join(upper, rel)).sort()) {
			const path = rel === "" ? name : `${rel}/${name}`;
			const st = lstatSync(join(upper, path));
			if (st.isCharacterDevice() && st.rdev === 0) entries[path] = { type: "whiteout" };
			else if (st.isSymbolicLink()) entries[path] = { type: "symlink", target: readlinkSync(join(upper, path)) };
			else if (st.isDirectory()) {
				entries[path] = { type: "dir", opaque: opaque(join(upper, path)), mode: st.mode & 0o7777 };
				walk(path);
			} else if (st.isFile()) entries[path] = { type: "file", sha256: createHash("sha256").update(readFileSync(join(upper, path))).digest("hex"), mode: st.mode & 0o777, size: st.size };
			// Nothing is dropped: FIFOs, sockets and devices are kept as they are.
			else entries[path] = { type: "special", mode: st.mode };
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
export function commitLayer(runDir: string, work: Work, root: string, attempt = 1): string | null {
	if (!existsSync(work.upper)) return null;
	const manifest = manifestOf(work.upper);
	if (Object.keys(manifest).length === 0) return null;
	const { digest, text } = digestOf(manifest);
	const dir = layerDir(runDir, digest);
	mkdirSync(layersDir(runDir), { recursive: true });
	if (!existsSync(`${dir}.json`)) writeDurably(`${dir}.json`, text);
	// Named in the call's dir first: a host that dies before the event restores the upper dir from it.
	writeDurably(join(root, "committed"), `${digest} ${attempt}`);
	if (existsSync(dir)) rmSync(work.upper, { recursive: true, force: true });
	else {
		syncTree(work.upper);
		renameSync(work.upper, dir);
		syncPath(layersDir(runDir));
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
export function squash(runDir: string, layers: readonly string[]): string {
	const merged = new Map<string, { entry: Entry; from: string }>();
	for (const layer of layers) {
		const manifest = readManifest(runDir, layer);
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
	const dir = layerDir(runDir, digest);
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
		else linkSync(join(layerDir(runDir, from), path), target);
	}
	syncTree(temp);
	writeDurably(`${dir}.json`, text);
	renameSync(temp, dir);
	syncPath(layersDir(runDir));
	return digest;
}

/** The session's layers after a call: its new layer on top, squashed into one beyond MAX_DEPTH. */
export function layersAfter(runDir: string, before: readonly string[], committed: string | null): string[] {
	const after = committed === null ? [...before] : [...before, committed];
	// One overlay may not name a dir twice: a layer already in the stack (content written back
	// to an earlier state) squashes it, like a deep one.
	const repeated = committed !== null && before.includes(committed);
	return after.length > MAX_DEPTH || repeated ? [squash(runDir, after)] : after;
}

/** A workspace as a view root: `/w`, its upper dir over its layers. */
export function workRoot(work: Work): ViewRoot {
	return { at: "/w", stack: [work.upper, ...[...work.lowers].reverse()], upper: work.upper };
}

/** The host file a workspace path names, through the layers (null: none, or a link out of `/w`). */
export function resolveIn(work: Work, rel: string): { readonly path: string; readonly writable: boolean } | null {
	try {
		const located = locate([workRoot(work)], `/w/${rel}`, true);
		const entry = located.entry;
		if (entry === null) return null;
		const path = entry.kind === "dir" ? entry.dirs[0]! : entry.host;
		return { path, writable: path === work.upper || path.startsWith(`${work.upper}/`) };
	} catch (error) {
		if (error instanceof ViewError) return null;
		throw error;
	}
}

function isWhiteout(path: string): boolean {
	try {
		const st = lstatSync(path);
		return st.isCharacterDevice() && st.rdev === 0;
	} catch {
		return false;
	}
}

/** A merged directory listing through the layers (names, sorted); null when it is not a dir. */
export function listIn(work: Work, rel: string): string[] | null {
	try {
		return listView(locate([workRoot(work)], `/w/${rel}`, true), rel);
	} catch (error) {
		if (error instanceof ViewError) return null;
		throw error;
	}
}

// --- The sandbox view, for the host's own file tools -------------------------------

/**
 * A root of the view the host's file tools see: a sandbox path and the
 * host dirs that make it, top first (an overlay's upper dir, then its
 * layers; a mount or the inputs: one dir). `upper` is where writes land
 * (null: read-only).
 */
export interface ViewRoot {
	readonly at: string;
	readonly stack: readonly string[];
	readonly upper: string | null;
}

/** A path the view does not allow: outside its roots, through a non-directory, or a loop. */
export class ViewError extends Error {
	override readonly name = "ViewError";
}

/** What a sandbox path names: a merged directory (its dirs, top first) or one host entry. */
export type ViewEntry =
	| { readonly kind: "dir"; readonly dirs: readonly string[] }
	| { readonly kind: "file" | "symlink" | "other"; readonly host: string };

/** The entry `name` of a merged directory, as overlayfs resolves it, with lstat only. */
function childOf(dirs: readonly string[], name: string): ViewEntry | null {
	const found: string[] = [];
	for (const dir of dirs) {
		const path = join(dir, name);
		let st;
		try {
			st = lstatSync(path);
		} catch {
			continue;
		}
		if (st.isCharacterDevice() && st.rdev === 0) break;
		if (st.isDirectory()) {
			found.push(path);
			if (opaque(path)) break;
			continue;
		}
		// A non-directory under a directory above is hidden by it.
		if (found.length > 0) break;
		return { kind: st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other", host: path };
	}
	return found.length > 0 ? { kind: "dir", dirs: found } : null;
}

/** Where a sandbox path is: its root, its path inside the root, and what is there (null: nothing). */
export interface Located {
	readonly root: ViewRoot;
	readonly rel: readonly string[];
	readonly entry: ViewEntry | null;
}

/**
 * Resolves a sandbox path one component at a time, never following a host
 * symlink: a symlink is followed (when not last, or with `follow`) by
 * resolving its target again inside the view, so a link that points out of
 * the sandbox roots is refused.
 */
export function locate(roots: readonly ViewRoot[], path: string, follow: boolean, create = false): Located {
	let target = posix.normalize(path);
	for (let hops = 0; hops <= 40; hops++) {
		const root = roots.filter((r) => target === r.at || target.startsWith(`${r.at}/`)).sort((a, b) => b.at.length - a.at.length)[0];
		if (!root) throw new ViewError(`${path} is outside this node's sandbox`);
		const parts = target.slice(root.at.length).split("/").filter((p) => p !== "");
		let current: ViewEntry = { kind: "dir", dirs: root.stack.filter((d) => existsSync(d) && lstatSync(d).isDirectory()) };
		let relinked = false;
		for (let i = 0; i < parts.length; i++) {
			if (current.kind !== "dir") throw new ViewError(`${path}: not a directory`);
			const entry = childOf(current.dirs, parts[i]!);
			const last = i === parts.length - 1;
			if (entry === null) {
				// Nothing here: a write makes the dirs that are missing (no link can follow them).
				if (last || create) return { root, rel: parts, entry: null };
				throw new ViewError(`${path}: no such file or directory`);
			}
			if (entry.kind === "symlink" && (!last || follow)) {
				let link: string;
				try {
					link = readlinkSync(entry.host);
				} catch {
					// It was a link when checked and is not now: changed under us, refused (typed).
					throw new ViewError(`${path}: changed while it was resolved (refused)`);
				}
				const here = posix.join(root.at, ...parts.slice(0, i));
				target = posix.normalize(posix.join(link.startsWith("/") ? link : posix.join(here, link), ...parts.slice(i + 1)));
				relinked = true;
				break;
			}
			current = entry;
		}
		if (!relinked) return { root, rel: parts, entry: current };
	}
	throw new ViewError(`${path}: too many levels of symbolic links`);
}

/** A path relative to an open dir: `openat` for Node, through the kernel's /proc/self/fd magic link. */
const at = (dirfd: number, name: string) => `/proc/self/fd/${dirfd}/${name}`;

/**
 * Opens `parts` under the host dir `base` as `openat` would, one component
 * at a time from `base`'s fd, never following a symlink: every dir is
 * opened `O_DIRECTORY | O_NOFOLLOW` relative to its parent's fd, and the
 * last component with `flags | O_NOFOLLOW`. A component swapped for a
 * symlink after `locate` checked it (an agent's bash shares the upper dir)
 * fails the open (a `ViewError`) instead of leading out of `base`. Returns
 * the fd (the caller closes it).
 */
export function openBeneath(base: string, parts: readonly string[], flags: number, mode?: number, path = parts.join("/")): number {
	if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("/"))) throw new ViewError(`${path}: not a plain path`);
	let dirfd = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		for (const part of parts.slice(0, -1)) {
			const next = openSync(at(dirfd, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			closeSync(dirfd);
			dirfd = next;
		}
		const last = parts.at(-1);
		return last === undefined ? openSync(at(dirfd, "."), flags | constants.O_NOFOLLOW) : openSync(at(dirfd, last), flags | constants.O_NOFOLLOW, mode);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "ENOTDIR" || code === "ENOENT") throw new ViewError(`${path}: changed while it was opened, or a link (refused)`);
		throw error;
	} finally {
		closeSync(dirfd);
	}
}

/** Which of a root's host dirs a located host path is in, and its components under it. */
function beneath(root: ViewRoot, host: string): { base: string; parts: string[] } {
	const base = root.stack.find((d) => host === d || host.startsWith(`${d}/`));
	if (base === undefined) throw new ViewError(`${host} is not in this root`);
	return { base, parts: host === base ? [] : host.slice(base.length + 1).split("/") };
}

/** A regular file of the view, opened for reading beneath its layer dir, never through a symlink (see `openBeneath`); the caller closes it. */
export function openViewFile(located: Located, path: string): number {
	const entry = located.entry;
	if (entry === null) throw new ViewError(`${path}: no such file`);
	if (entry.kind !== "file") throw new ViewError(`${path} is not a file`);
	const { base, parts } = beneath(located.root, entry.host);
	// Non-blocking: a FIFO swapped in for the file never blocks the host (and is refused below).
	const fd = openBeneath(base, parts, constants.O_RDONLY | constants.O_NONBLOCK, undefined, path);
	if (!fstatSync(fd).isFile()) {
		closeSync(fd);
		throw new ViewError(`${path} is not a file`);
	}
	return fd;
}

/** A file's content through the view (see `openViewFile`). */
export function readViewFile(located: Located, path: string): Buffer {
	const fd = openViewFile(located, path);
	try {
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** The names in a directory of the view, merged through its layers (whiteouts and opaque dirs honoured); each dir read through an fd opened beneath its layer. */
export function listView(located: Located, path: string): string[] {
	const entry = located.entry;
	if (entry === null || entry.kind !== "dir") throw new ViewError(`${path} is not a directory`);
	const names = new Set<string>();
	for (const dir of entry.dirs) {
		const { base, parts } = beneath(located.root, dir);
		const fd = openBeneath(base, parts, constants.O_RDONLY | constants.O_DIRECTORY, undefined, path);
		try {
			for (const name of readdirSync(`/proc/self/fd/${fd}`)) names.add(name);
		} finally {
			closeSync(fd);
		}
	}
	return [...names].filter((n) => childOf(entry.dirs, n) !== null).sort();
}

/**
 * Writes a file through the view: into its root's upper dir, never through
 * a symlink. Parent dirs are made in the upper dir; a whiteout there (a
 * file or dir the call deleted) is replaced, and a dir made over a deleted
 * one is marked opaque, as overlayfs does.
 */
export function writeViewFile(located: Located, path: string, content: string | Buffer): void {
	const upper = located.root.upper;
	if (upper === null) throw new ViewError(`${path} is read-only: only your workspace (/w) is writable`);
	// A path made of missing dirs is only written when it was located for a write.
	if (located.entry !== null && located.entry.kind !== "file") throw new ViewError(`${path} is not a file`);
	const rel = located.rel;
	if (rel.length === 0) throw new ViewError(`${path} is not a file`);
	if (rel.some((p) => p === "" || p === "." || p === ".." || p.includes("/"))) throw new ViewError(`${path}: not a plain path`);
	// Every dir is made and opened through its verified parent's fd (no symlink followed on the way),
	// so a component the agent's bash swaps for a link fails the write instead of leading out.
	let dirfd = openSync(upper, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	let dirPath = upper;
	try {
		for (const part of rel.slice(0, -1)) {
			dirPath = join(dirPath, part);
			let st;
			try {
				st = lstatSync(at(dirfd, part));
			} catch {
				st = null;
			}
			if (st === null) mkdirSync(at(dirfd, part));
			else if (st.isCharacterDevice() && st.rdev === 0) {
				// Deleted in this call: a new dir, opaque, so the layers' old one stays hidden.
				unlinkSync(at(dirfd, part));
				mkdirSync(at(dirfd, part));
				// setfattr is another process (its /proc/self is not ours): the host path, never followed (-h).
				markOpaque(dirPath);
			} else if (!st.isDirectory()) throw new ViewError(`${path}: not a directory`);
			let next: number;
			try {
				next = openSync(at(dirfd, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			} catch {
				throw new ViewError(`${path}: changed while it was opened, or a link (refused)`);
			}
			closeSync(dirfd);
			dirfd = next;
		}
		const name = rel.at(-1)!;
		if (isWhiteout(at(dirfd, name))) unlinkSync(at(dirfd, name));
		let fd: number;
		try {
			// Non-blocking: a FIFO there fails (ENXIO) instead of blocking the host.
			fd = openSync(at(dirfd, name), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new ViewError(`${path} is a link (refused)`);
			throw error;
		}
		try {
			if (!fstatSync(fd).isFile()) throw new ViewError(`${path} is not a file`);
			// Truncated only once it is known to be a regular file in the upper dir.
			ftruncateSync(fd, 0);
			writeSync(fd, typeof content === "string" ? Buffer.from(content) : content);
		} finally {
			closeSync(fd);
		}
	} finally {
		closeSync(dirfd);
	}
}

function markOpaque(dir: string): void {
	// -h: never through a link, should the dir be swapped for one.
	const r = spawnSync("setfattr", ["-h", "-n", "user.overlay.opaque", "-v", "y", dir], { encoding: "utf8" });
	if (r.status !== 0) throw new ViewError(`cannot mark ${dir} opaque: ${r.stderr.trim()}`);
}
