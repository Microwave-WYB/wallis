// Sandbox volumes, resolved (bwrap backend). A sandbox declares them in
// compose vocabulary (`sdk/volumes.ts`):
//
// - A bind volume (`<host path>:<target>:ro`) is a host dir, read-only at its
//   target. Its host path resolves against the workflow dir (`~/` against
//   the home dir); the caller can give another host dir for a target
//   (`--volume <target>=<dir>`, or the local profile's `volumes`), which
//   later hosts of the run reuse. Its content digest is part of the cache
//   key of every call in a sandbox that binds it.
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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Refusal } from "../sdk/index.ts";
import type { Volume } from "../sdk/volumes.ts";

/** Per workflow (or for all), the caller's host dir for a bind volume's target. */
export interface VolumeProfile {
	readonly global?: Readonly<Record<string, string>>;
	readonly workflows?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** A volume as a sandbox sees it: a host dir at a target, read-only (a bind) or writable (a named volume). */
export type ResolvedVolume =
	| { readonly kind: "bind"; readonly target: string; readonly dir: string }
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

/** Every device a sandbox declares exists on this host (bwrap binds it as declared); a missing one is refused. */
export function checkDevices(sandboxes: Readonly<Record<string, { readonly devices: readonly string[] }>>): void {
	for (const [sandbox, s] of Object.entries(sandboxes)) for (const device of s.devices) if (!device.startsWith("/dev/") || !existsSync(device)) throw new VolumeError({ type: "device_missing", sandbox, device });
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

/**
 * sha256 over the sorted relative paths and content hashes of every file
 * in the dir. File hashes are reused while a file's path, mtime and size
 * are unchanged.
 */
export function bindDigest(dir: string): string {
	const cache = loadCache();
	let dirty = false;
	const lines: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const path = join(d, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) {
				const st = statSync(path, { bigint: true });
				const key = `${path}\0${st.mtimeNs}\0${st.size}`;
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
