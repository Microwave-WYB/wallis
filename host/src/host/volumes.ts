// Sandbox volumes, resolved (bwrap backend). A sandbox declares them in
// compose vocabulary (`sdk/volumes.ts`):
//
// - A bind volume (`<host path>:<target>:ro`) is a host dir, read-only at its
//   target. Its host path resolves against the workflow dir (`~/` against
//   the home dir); the caller can give another host dir for a target
//   (`--volume <target>=<dir>`, or the local profile's `volumes`), which
//   later hosts of the run reuse. When a run starts, each bind is
//   snapshotted into the run (`<run>/binds/<hex>`, a content-addressed copy,
//   reflinked where the filesystem can): its calls see the snapshot, so an
//   edit made while the run is going on never reaches it; a later host of
//   the run reuses the snapshot, and a fork takes a new one. The snapshot's
//   digest is part of the cache key of every call in a sandbox that binds
//   it.
// - A named volume (`<name>:<target>`) is a wallis-managed writable dir,
//   `$XDG_CACHE_HOME/wallis/volumes/<name>`, shared across runs and left
//   out of every cache key: results must not depend on its contents.
//
// Targets are absolute and overlap neither a dir the bwrap backend owns
// (the host base, /proc, /dev, /in, /w, /tmp, /run/wallis) nor each other.
// Any other volume is a typed refusal at preflight, as is a declared device
// this host lacks.
//
// Per-file hashes are cached by path, mtime and size in
// `$XDG_CACHE_HOME/wallis/file-hashes.json`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import type { Refusal } from "../sdk/index.ts";
import type { Volume } from "../sdk/volumes.ts";
import { sandboxEnvProblem, secretEnvProblem } from "./hostbin.ts";

/** Per workflow (or for all), the caller's host dir for a bind volume's target. */
export interface VolumeProfile {
	readonly global?: Readonly<Record<string, string>>;
	readonly workflows?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** A volume as a sandbox sees it: a host dir at a target, read-only (a bind) or writable (a named volume). */
export type ResolvedVolume =
	| { readonly kind: "bind"; readonly target: string; readonly dir: string; readonly digest?: string }
	| { readonly kind: "named"; readonly target: string; readonly dir: string; readonly name: string };

export class VolumeError extends Error {
	override readonly name = "VolumeError";
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(`volume refused: ${JSON.stringify(refusal)}`);
		this.refusal = refusal;
	}
}

/** Dirs the bwrap backend owns: no volume may be at, under or above one. */
const RESERVED = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/dev", "/in", "/w", "/tmp", "/run/wallis"];

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function namedVolumesDir(): string {
	return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "wallis", "volumes");
}

/** Every sandbox's volumes, resolved, by sandbox name; a volume the backend cannot honour is refused. */
export function resolveVolumes(
	workflow: string,
	workflowDir: string,
	sandboxes: Readonly<Record<string, { readonly volumes: readonly Volume[] }>>,
	options: { readonly root: string; readonly callTime?: Readonly<Record<string, string>>; readonly profile?: VolumeProfile },
): Record<string, ResolvedVolume[]> {
	const binds = new Set(Object.values(sandboxes).flatMap((s) => s.volumes.flatMap((v) => (v.kind === "bind" ? [v.target] : []))));
	for (const target of Object.keys(options.callTime ?? {})) if (!binds.has(target)) throw new VolumeError({ type: "unknown_volume", target });
	const out: Record<string, ResolvedVolume[]> = {};
	for (const [sandbox, s] of Object.entries(sandboxes)) {
		const resolved: ResolvedVolume[] = [];
		for (const v of s.volumes) {
			const refuse = (reason: string): never => {
				throw new VolumeError({ type: "invalid_volume", sandbox, volume: v.kind === "invalid" ? v.text : `${v.kind === "bind" ? v.host : v.name}:${v.target}`, reason });
			};
			if (v.kind === "invalid") refuse(v.reason);
			else {
				const target = v.target.replace(/\/+$/, "") || "/";
				if (target !== v.target || target.split("/").some((p) => p === "." || p === "..")) refuse("the target must be a plain absolute path");
				const reserved = RESERVED.find((r) => overlaps(target, r));
				if (reserved !== undefined || target === "/") refuse(`the target overlaps ${reserved ?? "/"}, which the bwrap backend owns`);
				const other = resolved.find((r) => overlaps(r.target, target));
				if (other) refuse(`the target overlaps the volume at ${other.target}`);
				if (v.kind === "bind") {
					const given = options.callTime?.[target] || options.profile?.workflows?.[workflow]?.[target] || options.profile?.global?.[target];
					const dir = given ? resolve(options.root, given) : v.host.startsWith("~/") ? join(homedir(), v.host.slice(2)) : resolve(workflowDir, v.host);
					if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new VolumeError({ type: "volume_missing", sandbox, target, path: dir });
					resolved.push({ kind: "bind", target, dir });
				} else {
					const dir = join(namedVolumesDir(), v.name);
					mkdirSync(dir, { recursive: true });
					resolved.push({ kind: "named", target, dir, name: v.name });
				}
			}
		}
		out[sandbox] = resolved;
	}
	return out;
}

/** Device dirs that are shared state, not devices: never bound. */
const SHARED_DEV = ["/dev/shm", "/dev/pts", "/dev/mqueue", "/dev/fd"];

/**
 * Why a declared device is not one wallis binds (dev-bound, so writable),
 * or null: a plain path (`posix.normalize`) under /dev whose real path is a
 * character device under /dev, or a dir of them (`/dev/dri`), and not a
 * shared-state dir.
 */
export function deviceProblem(device: string): string | null {
	const inside = (p: string) => p.startsWith("/dev/") && !SHARED_DEV.some((d) => p === d || p.startsWith(`${d}/`));
	if (posix.normalize(device) !== device || !device.startsWith("/dev/")) return "a device is a plain path under /dev";
	if (!inside(device)) return "shared state, not a device";
	const real = realpathSync(device);
	if (!inside(real)) return `its real path ${real} is not a device under /dev`;
	const check = (path: string): string | null => {
		const st = statSync(path);
		if (st.isCharacterDevice()) return null;
		if (!st.isDirectory()) return `${path} is not a character device`;
		for (const entry of readdirSync(path)) {
			const real = realpathSync(join(path, entry));
			if (!inside(real)) return `${join(path, entry)} leads to ${real}, not a device under /dev`;
			const problem = check(real);
			if (problem) return problem;
		}
		return null;
	};
	return check(real);
}

/** Every device a sandbox declares exists on this host and is one wallis binds; anything else is refused, typed. */
export function checkDevices(sandboxes: Readonly<Record<string, { readonly devices: readonly string[] }>>): void {
	for (const [sandbox, s] of Object.entries(sandboxes)) {
		for (const device of s.devices) {
			if (posix.normalize(device) === device && device.startsWith("/dev/") && !existsSync(device)) throw new VolumeError({ type: "device_missing", sandbox, device });
			const reason = deviceProblem(device);
			if (reason !== null) throw new VolumeError({ type: "invalid_device", sandbox, device, reason });
		}
	}
}

/**
 * Every environment variable a sandbox declares, and every secret a tool
 * source carries (toolset `secrets`, an MCP server's `env`), is one it may
 * set; anything else is refused, typed (`invalid_environment`).
 */
export function checkEnvironments(decl: {
	readonly sandboxes: Readonly<Record<string, { readonly environment: Readonly<Record<string, string>> }>>;
	readonly toolsets: Readonly<Record<string, { readonly sandbox: string; readonly secrets: readonly string[] }>>;
	readonly mcp: unknown;
	readonly mcpServers: Readonly<Record<string, { readonly sandbox: string | null }>>;
}): void {
	const refuse = (sandbox: string, key: string, reason: string | null) => {
		if (reason !== null) throw new VolumeError({ type: "invalid_environment", sandbox, key, reason });
	};
	for (const [sandbox, s] of Object.entries(decl.sandboxes)) for (const key of Object.keys(s.environment)) refuse(sandbox, key, sandboxEnvProblem(key));
	for (const t of Object.values(decl.toolsets)) for (const key of t.secrets) refuse(t.sandbox, key, secretEnvProblem(key));
	const servers = ((decl.mcp as { mcpServers?: Record<string, { env?: Record<string, unknown> }> } | null)?.mcpServers ?? {}) as Record<string, { env?: Record<string, unknown> }>;
	for (const [server, config] of Object.entries(servers)) for (const key of Object.keys(config.env ?? {})) refuse(decl.mcpServers[server]?.sandbox ?? server, key, secretEnvProblem(key));
}

type HashCache = Record<string, string>;

function cachePath(): string {
	return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "wallis", "file-hashes.json");
}

function loadCache(): HashCache {
	try {
		return JSON.parse(readFileSync(cachePath(), "utf8")) as HashCache;
	} catch {
		return {};
	}
}

/** Where a run keeps the files a command call wrote, by their digest. */
export function commandOutputsDir(runDir: string, digest: string): string {
	return join(runDir, "outputs", digest.slice(digest.lastIndexOf(":") + 1));
}

/**
 * Keeps the files a command call wrote (its scratch dir, moved: no copy)
 * in the run, named by their digest. A journaled
 * process result names them, so the current `parse` can read them on
 * every delivery. A call that wrote nothing keeps an empty dir.
 */
export function storeCommandOutputs(runDir: string, scratch: string): string {
	mkdirSync(scratch, { recursive: true });
	const digest = bindDigest(scratch);
	const target = commandOutputsDir(runDir, digest);
	mkdirSync(dirname(target), { recursive: true });
	if (existsSync(target)) rmSync(scratch, { recursive: true, force: true });
	else renameSync(scratch, target);
	return digest;
}

/** Where a run keeps the snapshot of a bind by its digest. */
export function bindSnapshotDir(runDir: string, digest: string): string {
	return join(runDir, "binds", digest.slice(digest.lastIndexOf(":") + 1));
}

/**
 * Snapshots a bind's host dir into the run: a copy (`cp -a
 * --reflink=auto`: a reflink where the filesystem has them, else a plain
 * copy), named by its digest; an identical snapshot already there is
 * reused. Returns the digest.
 */
export function snapshotBind(runDir: string, dir: string): string {
	mkdirSync(join(runDir, "binds"), { recursive: true });
	const temp = join(runDir, "binds", `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
	const copied = spawnSync("cp", ["-a", "--reflink=auto", "--no-target-directory", dir, temp], { encoding: "utf8" });
	if (copied.status !== 0) {
		rmSync(temp, { recursive: true, force: true });
		throw new Error(`cannot snapshot bind ${dir}: ${copied.stderr.trim()}`);
	}
	// File hashes come from the cache of the host dir: `cp -a` keeps mtimes and sizes.
	const digest = bindDigest(temp, dir);
	const target = bindSnapshotDir(runDir, digest);
	if (existsSync(target)) rmSync(temp, { recursive: true, force: true });
	else renameSync(temp, target);
	return digest;
}

/**
 * sha256 over the sorted relative paths and content hashes of every file
 * in the dir, and the targets of its symlinks. File hashes are reused
 * while a file's path (under `cacheAs`, by default the dir itself), mtime
 * and size are unchanged.
 */
export function bindDigest(dir: string, cacheAs = dir): string {
	const cache = loadCache();
	let dirty = false;
	const lines: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const path = join(d, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isSymbolicLink()) lines.push(`${relative(dir, path)}\t-> ${readlinkSync(path)}`);
			else if (entry.isFile()) {
				const st = statSync(path, { bigint: true });
				const key = `${join(cacheAs, relative(dir, path))}\0${st.mtimeNs}\0${st.size}`;
				let hash = cache[key];
				if (!hash) {
					hash = createHash("sha256").update(readFileSync(path)).digest("hex");
					cache[key] = hash;
					dirty = true;
				}
				lines.push(`${relative(dir, path)}\t${hash}`);
			}
		}
	};
	walk(dir);
	if (dirty) {
		try {
			mkdirSync(dirname(cachePath()), { recursive: true });
			writeFileSync(cachePath(), JSON.stringify(cache));
		} catch {
			// The cache only saves time; digests do not depend on it.
		}
	}
	return `bind:sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}
