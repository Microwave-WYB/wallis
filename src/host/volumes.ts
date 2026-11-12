// Sandbox volumes, in Docker/compose vocabulary (docs/v2.md §4.4).
//
//   "<host path>:<container target>:ro"  a bind volume: a host dir, read-only.
//                                         The mode must be written, and only
//                                         `ro` exists. The host path is
//                                         relative (to the workflow dir) or
//                                         starts with `~/`.
//   "<name>:<container target>"          a named volume: a wallis-managed dir
//                                         that persists across runs, writable
//                                         by commands and tool sources,
//                                         read-only for agents. Environments
//                                         live here.
//
// The same rules are a type (a wrong volume is a compile error with a
// readable message) and a parse (`parseVolume`), so a volume that slips past
// the types is an error before the run starts, never dropped.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** A volume, parsed. `invalid` keeps the text and why, for a typed refusal. */
export type Volume =
	| { readonly kind: "bind"; readonly host: string; readonly target: string }
	| { readonly kind: "named"; readonly name: string; readonly target: string }
	| { readonly kind: "invalid"; readonly text: string; readonly reason: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A host path a bind may name: relative, or under the home dir. */
const hostPath = (h: string) => h.startsWith("./") || h.startsWith("../") || h.startsWith("~/");

export function parseVolume(text: string): Volume {
	const parts = text.split(":");
	const invalid = (reason: string): Volume => ({ kind: "invalid", text, reason });
	if (parts.length === 3) {
		const [host, target, mode] = parts as [string, string, string];
		if (mode !== "ro") return invalid(`mode ${mode}: only :ro exists (a bind is never writable; write user dirs with exportOutput)`);
		if (!hostPath(host)) return invalid("a bind's host path is relative (./ or ../) or starts with ~/");
		if (!target.startsWith("/")) return invalid("the container target must be absolute");
		return { kind: "bind", host, target };
	}
	if (parts.length === 2) {
		const [source, target] = parts as [string, string];
		if (hostPath(source) || source.startsWith("/")) return invalid("a bind volume needs its mode: <host path>:<target>:ro");
		if (!NAME.test(source)) return invalid("a named volume's name is letters, digits, _ . -");
		if (!target.startsWith("/")) return invalid("the container target must be absolute");
		return { kind: "named", name: source, target };
	}
	return invalid("a volume is <host path>:<target>:ro or <name>:<target>");
}

type HostPath = `./${string}` | `../${string}` | `~/${string}`;

/** Dirs the bwrap backend owns (`resolveVolumes` refuses the same). */
type Reserved = "/usr" | "/etc" | "/bin" | "/sbin" | "/lib" | "/lib32" | "/lib64" | "/libx32" | "/proc" | "/dev" | "/in" | "/w" | "/tmp" | "/run/wallis";

/** A target as the types check it: absolute, and neither at, under nor above a reserved dir. */
type Target<T extends string, V extends string> = T extends `/${string}`
	? T extends Reserved | `${Reserved}/${string}` | "/" | "/run"
		? "error: the target overlaps a dir the bwrap backend owns (/usr /etc /bin /sbin /lib* /proc /dev /in /w /tmp /run/wallis)"
		: V
	: "error: the container target must be absolute";

/** A volume string as the types check it: itself, or a readable error. */
export type CheckVolume<V extends string> = V extends `${infer H}:${infer T}:${infer M}`
	? M extends "ro"
		? H extends HostPath
			? Target<T, V>
			: "error: a bind's host path is relative (./ or ../) or starts with ~/"
		: `error: mode :${M}: only :ro exists (a volume is never writable)`
	: V extends `${infer N}:${infer T}`
		? N extends HostPath | `/${string}`
			? "error: a bind volume needs its mode: <host path>:<target>:ro"
			: Target<T, V>
		: "error: a volume is <host path>:<target>:ro or <name>:<target>";

/** Each volume of a list, checked. */
export type CheckVolumes<V extends readonly string[]> = { readonly [K in keyof V]: CheckVolume<V[K]> };

// --- Resolution (bwrap backend) ------------------------------------------------
//
// A bind's host path resolves against the workflow file's dir (`~/` against
// the home dir) and is bound live, read-only: what a run read is recorded
// in its calls' inputs and outputs, not snapshotted. A named volume is
// `$XDG_CACHE_HOME/wallis/volumes/<name>`.

/** A volume as a sandbox sees it: a host dir at a target. */
export type ResolvedVolume =
	| { readonly kind: "bind"; readonly target: string; readonly dir: string }
	| { readonly kind: "named"; readonly target: string; readonly dir: string };

export class VolumeError extends Error {
	override readonly name = "VolumeError";
	readonly volume: string;
	constructor(volume: string, reason: string) {
		super(`volume ${volume}: ${reason}`);
		this.volume = volume;
	}
}

/** Dirs the bwrap backend owns: no volume may be at, under or above one. */
const RESERVED = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/dev", "/in", "/w", "/tmp", "/run/wallis"];

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** A project's named volumes: `<project>/.wallis/volumes/<name>`, so two projects never share one. */
export function namedVolumesDir(root: string): string {
	return join(root, ".wallis", "volumes");
}

/**
 * A sandbox's volumes, resolved. A volume the backend cannot honour (a bad
 * text, a target it owns or one another volume overlaps, a missing host
 * dir, a bind inside or around the project's `.wallis`) is a `VolumeError`
 * that names it and says what to fix.
 */
export function resolveVolumes(texts: readonly string[], workflowDir: string, options: { readonly stores?: readonly string[]; readonly root?: string } = {}): ResolvedVolume[] {
	const resolved: ResolvedVolume[] = [];
	for (const text of texts) {
		const v = parseVolume(text);
		const refuse = (reason: string): never => {
			throw new VolumeError(text, reason);
		};
		if (v.kind === "invalid") refuse(v.reason);
		else {
			const target = v.target.replace(/\/+$/, "") || "/";
			if (target !== v.target || target.split("/").some((p) => p === "." || p === "..")) refuse("the target must be a plain absolute path");
			const reserved = RESERVED.find((r) => overlaps(target, r));
			if (reserved !== undefined || target === "/") refuse(`the target overlaps ${reserved ?? "/"}, which the sandbox owns`);
			const other = resolved.find((r) => overlaps(r.target, target));
			if (other) refuse(`the target overlaps the volume at ${other.target}`);
			if (v.kind === "bind") {
				const dir = v.host.startsWith("~/") ? join(homedir(), v.host.slice(2)) : resolve(workflowDir, v.host);
				if (!existsSync(dir) || !statSync(dir).isDirectory()) refuse(`the host dir ${dir} does not exist; create it or fix the path`);
				const real = realpathSync(dir);
				for (const store of options.stores ?? []) {
					const s = existsSync(store) ? realpathSync(store) : resolve(store);
					if (overlaps(real, s)) refuse(`the host dir ${dir} overlaps ${store}, wallis's own`);
				}
				resolved.push({ kind: "bind", target, dir: real });
			} else {
				const dir = join(namedVolumesDir(options.root ?? workflowDir), v.name);
				mkdirSync(dir, { recursive: true });
				resolved.push({ kind: "named", target, dir });
			}
		}
	}
	return resolved;
}

/**
 * Runs `f` holding the lock of every named volume the commands write (`<volume>.lock`, with the
 * holder's pid; a dead holder's is stale): two commands that share a named volume (an environment
 * set up in it, a cache) never write it at the same time.
 */
export async function withVolumeLocks<T>(volumes: readonly ResolvedVolume[], f: () => Promise<T>): Promise<T> {
	const dirs = [...new Set(volumes.flatMap((v) => (v.kind === "named" ? [v.dir] : [])))].sort();
	const held: string[] = [];
	try {
		for (const dir of dirs) {
			const lock = `${dir}.lock`;
			for (;;) {
				try {
					writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
					held.push(lock);
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const pid = Number(readFileSync(lock, "utf8").trim());
					let alive = false;
					try {
						process.kill(pid, 0);
						alive = true;
					} catch (e) {
						alive = (e as NodeJS.ErrnoException).code === "EPERM";
					}
					if (!alive) rmSync(lock, { force: true });
					else await new Promise((d) => setTimeout(d, 50));
				}
			}
		}
		return await f();
	} finally {
		for (const lock of held) rmSync(lock, { force: true });
	}
}
