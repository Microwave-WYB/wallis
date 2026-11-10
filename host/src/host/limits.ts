// Per-sandbox memory and process limits. Every sandboxed process (an
// agent's shell, a command, a tool process, a sandbox's setup and checks)
// runs in its own systemd user scope:
//
//   systemd-run --user --scope -p MemoryMax=<m> -p MemorySwapMax=0 -p TasksMax=<n> -- bwrap ...
//
// by absolute path. Defaults: MemoryMax 8G, TasksMax 512. A sandbox
// overrides them compose-style (`mem_limit: "2g"`, `pids_limit: 64`); a
// command's `resources.memoryGb` replaces the default memory limit, capped
// by the sandbox's `mem_limit`. Swap is off in the scope, so `mem_limit` is
// all the memory the processes get.
//
// While a process runs, its scope's cgroup is watched (`memory.events`
// `oom_kill`, `pids.events` `max`). The first limit hit stops the whole
// scope (`cgroup.kill`) and the result names it: a command fails with
// `resource_limit`. An OOM kill can end the scope before the watch reads
// it, so a process killed by a signal nobody here sent is looked up in
// systemd too: its scope runs without `--collect`, and one the OOM killer
// ended stays loaded as failed with `Result=oom-kill` until it is read
// (then `reset-failed`). Without a systemd user manager nothing sandboxed runs
// (`limits_unavailable`, typed): never without limits.
//
// Limits are outside every cache key (like named volumes): a result does
// not depend on them, and hitting one is a failure, not a result.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { SandboxDecl } from "./confine.ts";
import { hostEnv, hostProgram } from "./hostbin.ts";
import { systemdAvailable } from "./slots.ts";

export const DEFAULT_MEMORY_MAX = 8 * 1024 ** 3;
export const DEFAULT_TASKS_MAX = 512;

/** Which limit was hit, compose names (`Limit` in the core). */
export type Limit = "mem_limit" | "pids_limit";

/** A limit that was hit, at its value: bytes for `mem_limit`, processes for `pids_limit`. */
export interface LimitHit {
	readonly limit: Limit;
	readonly max: number;
}

/** The systemd scope a sandboxed process runs in. */
export interface Scope {
	/** The scope's unit name, without `.scope`. */
	readonly unit: string;
	/** Bytes. */
	readonly memoryMax: number;
	readonly tasksMax: number;
}

const UNITS: Readonly<Record<string, number>> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** A compose `mem_limit` (`"2g"`, `"512m"`, `"65536k"`, `"1048576b"`) in bytes, or the reason it is not one. */
export function parseMemLimit(raw: string): { ok: true; bytes: number } | { ok: false; reason: string } {
	const m = /^([1-9][0-9]*)([bkmg])$/.exec(raw);
	if (!m) return { ok: false, reason: `mem_limit ${JSON.stringify(raw)} is not a positive integer with a unit b, k, m or g (e.g. "2g")` };
	const bytes = Number(m[1]) * UNITS[m[2]!]!;
	if (!Number.isSafeInteger(bytes)) return { ok: false, reason: `mem_limit ${raw} is too large` };
	if (bytes < 1024 ** 2) return { ok: false, reason: `mem_limit ${raw} is below 1m` };
	return { ok: true, bytes };
}

/** Why a declared `pids_limit` is not one, or null. */
export function pidsLimitProblem(n: number): string | null {
	return Number.isSafeInteger(n) && n >= 1 ? null : `pids_limit ${n} is not a positive integer`;
}

let counter = 0;
const prefix = `wallis-sbx-${process.pid}-${randomBytes(3).toString("hex")}`;

/** The unit-name prefix of every scope this host process creates (`<prefix>-<n>`). */
export function scopePrefix(): string {
	return prefix;
}

/**
 * The scope of one sandboxed process: the sandbox's limits (declared, else
 * the defaults), a command's `memoryGb` in place of the default memory.
 * The declarations were checked at parse time; a bad value here is a bug.
 */
export function scopeFor(s: Pick<SandboxDecl, "mem_limit" | "pids_limit">, options: { readonly memoryGb?: number } = {}): Scope {
	const declared = s.mem_limit === null ? null : parseMemLimit(s.mem_limit);
	if (declared && !declared.ok) throw new Error(declared.reason);
	const wanted = options.memoryGb ? Math.ceil(options.memoryGb * 1024 ** 3) : null;
	const memoryMax = declared ? (wanted === null ? declared.bytes : Math.min(declared.bytes, wanted)) : (wanted ?? DEFAULT_MEMORY_MAX);
	return { unit: `${prefix}-${++counter}`, memoryMax, tasksMax: s.pids_limit ?? DEFAULT_TASKS_MAX };
}

export class LimitsUnavailable extends Error {
	override readonly name = "LimitsUnavailable";
	readonly reason: string;
	constructor(reason: string) {
		super(`limits_unavailable: ${reason}`);
		this.reason = reason;
	}
}

const BUS = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

/**
 * How to start `command args` in its scope: systemd-run (absolute path),
 * with the session bus it needs in its environment and unset again for
 * bwrap's child (`--unsetenv`). Refused when no user manager is reachable.
 */
export function inScope(
	scope: Scope,
	command: string,
	args: readonly string[],
	env: Readonly<Record<string, string>>,
	options: { readonly observed?: boolean } = {},
): { command: string; args: string[]; env: Record<string, string> } {
	if (!systemdAvailable()) throw new LimitsUnavailable("systemd-run --user --scope does not work here (no systemd user manager); sandboxes never run without memory and process limits");
	const bus = hostEnv();
	const props = [`MemoryMax=${scope.memoryMax}`, "MemorySwapMax=0", `TasksMax=${scope.tasksMax}`].flatMap((p) => ["-p", p]);
	const unset = Object.keys(bus).flatMap((k) => ["--unsetenv", k]);
	return {
		command: hostProgram("systemd-run"),
		// Observed (`scopeResult` reads it afterwards): kept when it failed, so an OOM kill is not lost.
		args: ["--user", "--scope", "--quiet", ...(options.observed ? [] : ["--collect"]), `--unit=${scope.unit}`, ...props, "--", command, ...unset, ...args],
		env: { ...env, ...bus },
	};
}

/**
 * Watches the scope of a running process (pid: systemd-run, which execs
 * bwrap): the first limit hit stops the whole scope and is remembered.
 * `stop()` reads the counters a last time and ends the watch.
 */
export function watchScope(pid: number, scope: Scope, onHit: () => void = () => {}): { hit(): LimitHit | null; stop(): void } {
	let dir: string | null = null;
	let hit: LimitHit | null = null;
	const events = (file: string, key: string): number => {
		try {
			const line = readFileSync(`${dir}/${file}`, "utf8").split("\n").find((l) => l.startsWith(`${key} `));
			return line ? Number(line.slice(key.length + 1)) : 0;
		} catch {
			return 0;
		}
	};
	const check = () => {
		if (hit) return;
		if (dir === null) {
			try {
				const path = readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::"))?.slice(3);
				if (path?.endsWith(`/${scope.unit}.scope`)) dir = `/sys/fs/cgroup${path}`;
			} catch {
				// not started yet, or gone
			}
			if (dir === null) return;
		}
		if (events("memory.events", "oom_kill") > 0) hit = { limit: "mem_limit", max: scope.memoryMax };
		else if (events("pids.events", "max") > 0) hit = { limit: "pids_limit", max: scope.tasksMax };
		if (hit) {
			try {
				writeFileSync(`${dir}/cgroup.kill`, "1");
			} catch {
				// gone already
			}
			onHit();
		}
	};
	check();
	const timer = setInterval(check, 50);
	return {
		hit: () => hit,
		stop: () => {
			clearInterval(timer);
			check();
		},
	};
}

const systemctl = (args: string[]) =>
	new Promise<string>((done) => execFile(hostProgram("systemctl"), ["--user", ...args], { env: hostEnv(), encoding: "utf8" }, (_error, stdout) => done(stdout ?? "")));

/**
 * After an observed scope's process ended by a signal: the limit systemd
 * recorded (`Result=oom-kill` is `mem_limit`), or null. Waits (briefly) for
 * the scope to settle, then clears a failed one.
 */
export async function scopeResult(scope: Scope): Promise<LimitHit | null> {
	const unit = `${scope.unit}.scope`;
	for (let i = 0; i < 40; i++) {
		const props = Object.fromEntries(
			(await systemctl(["show", "-p", "LoadState", "-p", "ActiveState", "-p", "Result", unit]))
				.trim()
				.split("\n")
				.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
		);
		if (props.LoadState === "not-found") return null;
		if (props.ActiveState === "failed" || props.ActiveState === "inactive") {
			if (props.ActiveState === "failed") await systemctl(["reset-failed", unit]);
			return props.Result === "oom-kill" ? { limit: "mem_limit", max: scope.memoryMax } : null;
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	return null;
}
