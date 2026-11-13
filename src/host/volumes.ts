// Sandbox volumes, in Docker/compose vocabulary (docs/v2.md §4.4).
//
//   "<host path>:<container target>:ro"  a bind volume: a host dir, read-only.
//                                         The mode must be written, and only
//                                         `ro` exists. The host path is
//                                         relative (to the workflow dir) or
//                                         starts with `~/`.
//   "<name>:<container target>"          a named volume: a wallis-managed dir
//                                         that persists across runs, writable
//                                         by commands and tool sources (one
//                                         writer at a time, and no reader
//                                         then), read-only for agents.
//                                         Environments live here.
//   "<name>:<container target>:ro"       the same volume, read-only: readers
//                                         share it and run at the same time.
//
// The same rules are a type (a wrong volume is a compile error with a
// readable message) and a parse (`parseVolume`), so a volume that slips past
// the types is an error before the run starts, never dropped.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hostProgram } from "./sandbox.ts";

/** A volume, parsed. `invalid` keeps the text and why, for a typed refusal. */
export type Volume =
	| { readonly kind: "bind"; readonly host: string; readonly target: string }
	| { readonly kind: "named"; readonly name: string; readonly target: string; readonly readOnly: boolean }
	| { readonly kind: "invalid"; readonly text: string; readonly reason: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A host path a bind may name: relative, or under the home dir. */
const hostPath = (h: string) => h.startsWith("./") || h.startsWith("../") || h.startsWith("~/");

export function parseVolume(text: string): Volume {
	const parts = text.split(":");
	const invalid = (reason: string): Volume => ({ kind: "invalid", text, reason });
	if (parts.length === 3) {
		const [host, target, mode] = parts as [string, string, string];
		if (mode !== "ro") return invalid(`mode ${mode}: only :ro exists (a bind is never writable, write user dirs with exportOutput; a named volume without a mode is writable)`);
		if (!target.startsWith("/")) return invalid("the container target must be absolute");
		if (hostPath(host)) return { kind: "bind", host, target };
		if (host.startsWith("/")) return invalid("a bind's host path is relative (./ or ../) or starts with ~/");
		if (!NAME.test(host)) return invalid("a named volume's name is letters, digits, _ . -");
		return { kind: "named", name: host, target, readOnly: true };
	}
	if (parts.length === 2) {
		const [source, target] = parts as [string, string];
		if (hostPath(source) || source.startsWith("/")) return invalid("a bind volume needs its mode: <host path>:<target>:ro");
		if (!NAME.test(source)) return invalid("a named volume's name is letters, digits, _ . -");
		if (!target.startsWith("/")) return invalid("the container target must be absolute");
		return { kind: "named", name: source, target, readOnly: false };
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
		? H extends `/${string}`
			? "error: a bind's host path is relative (./ or ../) or starts with ~/"
			: Target<T, V>
		: `error: mode :${M}: only :ro exists (a bind is never writable; a named volume without a mode is writable)`
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
// `<project>/.wallis/volumes/<name>`.

/** A volume as a sandbox sees it: a host dir at a target. */
export type ResolvedVolume =
	| { readonly kind: "bind"; readonly target: string; readonly dir: string }
	| { readonly kind: "named"; readonly target: string; readonly dir: string; readonly name: string; readonly readOnly: boolean };

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
				const same = resolved.find((r) => r.kind === "named" && r.name === v.name);
				if (same) refuse(`the volume ${v.name} is already mounted at ${same.target}; mount a volume once per sandbox`);
				oldVolumesNotice();
				const dir = join(namedVolumesDir(options.root ?? workflowDir), v.name);
				mkdirSync(dir, { recursive: true });
				resolved.push({ kind: "named", target, dir, name: v.name, readOnly: v.readOnly });
			}
		}
	}
	return resolved;
}

let noticed = false;

/** Named volumes used to live in the user's cache; once per process, a note that they are no longer used. */
function oldVolumesNotice(): void {
	if (noticed) return;
	noticed = true;
	const old = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "wallis", "volumes");
	let names: string[] = [];
	try {
		names = readdirSync(old);
	} catch {
		return;
	}
	if (names.length > 0) console.warn(`wallis: named volumes are now per project (<project>/.wallis/volumes/); the ones in ${old} (${names.join(", ")}) are no longer used: move one into a project's .wallis/volumes/ to keep it, or delete them`);
}

/** How a process holds a named volume: shared by readers, exclusive for its one writer. */
export type VolumeAccess = "shared" | "exclusive";

/** Every named volume of a sandbox and how a process holds it: agents and `:ro` mounts read. */
export function volumeAccess(volumes: readonly ResolvedVolume[], agent: boolean): { readonly dir: string; readonly name: string; readonly access: VolumeAccess }[] {
	return volumes.flatMap((v) => (v.kind === "named" ? [{ dir: v.dir, name: v.name, access: agent || v.readOnly ? ("shared" as const) : ("exclusive" as const) }] : [])).sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

export class VolumeLockError extends Error {
	override readonly name = "VolumeLockError";
}

/** Held volume locks; `release` gives them all back. */
export interface VolumeLocks {
	release(): Promise<void>;
}

/**
 * Takes the lock of every named volume a sandbox mounts, in a fixed order: shared for readers
 * (`:ro`, agents), exclusive for a writer. Each lock is `flock(2)` on `<volume>.lock`, held by a
 * `flock` process whose stdin is a pipe from this one: the kernel releases it when that process
 * ends, so a holder that died (and its pid, reused or not) never keeps it. A wait is reported once
 * (`onWait(name)`, then `onWait(null)` when it got it) and ends at `signal` with an AbortError.
 */
export async function lockVolumes(volumes: readonly ResolvedVolume[], options: { readonly agent?: boolean; readonly signal?: AbortSignal; readonly onWait?: (volume: string | null) => void } = {}): Promise<VolumeLocks> {
	const held: { end(): Promise<void> }[] = [];
	const release = async () => {
		await Promise.all(held.splice(0).map((h) => h.end()));
	};
	try {
		for (const v of volumeAccess(volumes, options.agent ?? false)) held.push(await lockOne(v, options));
	} catch (e) {
		await release();
		throw e;
	}
	return { release };
}

function lockOne(v: { readonly dir: string; readonly name: string; readonly access: VolumeAccess }, options: { readonly signal?: AbortSignal; readonly onWait?: (volume: string | null) => void }): Promise<{ end(): Promise<void> }> {
	return new Promise((done, fail) => {
		if (options.signal?.aborted) return fail(abortError(v.name));
		// -o: the command does not inherit the lock's fd, so only flock holds it; it ends when its stdin does.
		const child = spawn(hostProgram("flock"), [v.access === "shared" ? "-s" : "-x", "-o", `${v.dir}.lock`, "-c", "echo held; exec cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
		let waiting = false;
		let got = false;
		let stderr = "";
		const exited = new Promise<void>((r) => child.once("close", () => r()));
		const timer = setTimeout(() => {
			if (!got) (waiting = true), options.onWait?.(v.name);
		}, 100);
		const onAbort = () => {
			child.kill("SIGKILL");
			fail(abortError(v.name));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
		child.stdout.once("data", () => {
			got = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (waiting) options.onWait?.(null);
			done({
				end: async () => {
					child.stdin.end();
					await exited;
				},
			});
		});
		child.once("error", (e) => {
			clearTimeout(timer);
			fail((e as NodeJS.ErrnoException).code === "ENOENT" ? new VolumeLockError("flock is not installed (util-linux): wallis locks named volumes with it; install util-linux") : e);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (!got && !options.signal?.aborted) fail(new VolumeLockError(`could not lock the volume ${v.name}: flock exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
		});
		child.stdin.on("error", () => {});
	});
}

function abortError(name: string): Error {
	const e = new Error(`stopped while waiting for the volume ${name}`);
	e.name = "AbortError";
	return e;
}
