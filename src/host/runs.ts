// Where runs live and which process drives them.
//
// A run belongs to the project of its workflow file: the nearest ancestor
// with `.wallis/` or `package.json` (docs/v2.md §7). Its directory is
// `<root>/.wallis/runs/<run id>/`:
//   log.jsonl   the append-only event log, the run's single commit point
//   meta.json   a cache: the host facts the log notes, with the log size it
//               was derived at; rebuilt from the log when stale
//   lock        the pid of the process driving the run
//   work/       per-call scratch dirs, discarded when the call settles
//
// Values live in the project's store (store.ts), not here. A run that is
// not finished and has no live lock holder is stopped, and resumable: that
// is computed when asked, never logged.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Core, type Json } from "./core.ts";
import { EventLog } from "./log.ts";

export interface RunPaths {
	readonly dir: string;
	readonly id: string;
	readonly log: string;
	readonly meta: string;
	readonly lock: string;
	readonly work: string;
}

/** A call's own dir under the run's `work/`: its whole slot (node, input, scope, occurrence) and attempt, so identical calls at once never share one. */
export function callDir(slot: string, attempt: number): string {
	return `${slot.replace(/[^A-Za-z0-9._-]/g, "_")}-a${attempt}`;
}

export function runPaths(dir: string): RunPaths {
	const abs = resolve(dir);
	return { dir: abs, id: basename(abs), log: join(abs, "log.jsonl"), meta: join(abs, "meta.json"), lock: join(abs, "lock"), work: join(abs, "work") };
}

/** The project a file belongs to: its nearest ancestor dir with `.wallis/` or `package.json`; else the file's own dir. */
export function projectOf(file: string): string {
	const start = dirname(resolve(file));
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".wallis")) || existsSync(join(dir, "package.json"))) return dir;
		if (dirname(dir) === dir) return start;
	}
}

export function runsDir(root: string): string {
	return join(resolve(root), ".wallis", "runs");
}

/** `<workflow>-<utc stamp>-<random>`: sortable, and unique enough for one machine. */
export function newRunId(workflow: string, now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
	const label = workflow.replace(/[^A-Za-z0-9_.-]/g, "-") || "run";
	return `${label}-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function listRuns(root: string): RunPaths[] {
	const dir = runsDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.sort()
		.map((id) => runPaths(join(dir, id)))
		// A run that started but has not logged yet counts too: its start.json names its inputs.
		.filter((p) => existsSync(p.log) || existsSync(join(p.dir, "start.json")) || existsSync(p.lock));
}

// --- Meta ----------------------------------------------------------------------

export type RunMeta = Readonly<Record<string, Json>> & { readonly run_id: string };

type Cache = { log_bytes: number; meta: Record<string, Json> };

function readCache(file: string): Cache | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const raw: unknown = JSON.parse(text);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const { log_bytes, meta } = raw as { log_bytes?: unknown; meta?: unknown };
	if (typeof log_bytes !== "number" || meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
	return { log_bytes, meta: meta as Record<string, Json> };
}

/** A whole file or none: written to a temp file and renamed. */
export function writeAtomic(file: string, text: string): void {
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temp, text);
	renameSync(temp, file);
}

/**
 * The run's metadata: the host facts its log notes. `meta.json` caches them
 * with the log size they were derived at, written atomically; a stale cache
 * is rebuilt from the log.
 */
export function readMeta(paths: RunPaths): RunMeta | null {
	const size = existsSync(paths.log) ? statSync(paths.log).size : 0;
	if (size === 0) return null;
	const cached = readCache(paths.meta);
	if (cached !== null && cached.log_bytes === size) return { ...cached.meta, run_id: paths.id };
	const facts = Core.refold(new EventLog(paths.log).read()).facts();
	writeAtomic(paths.meta, `${JSON.stringify({ log_bytes: size, meta: facts }, null, 2)}\n`);
	return { ...facts, run_id: paths.id };
}

// --- Lock ----------------------------------------------------------------------

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A process's start time (clock ticks since boot, /proc/<pid>/stat field 22), or null when it is gone. */
export function startTime(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name (field 2) may hold spaces and parens: fields are counted after its last ')'.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}

/** The lock's content: the holder's pid and its start time, so a reused pid is never taken for it. */
function lockText(pid: number): string {
	return `${pid} ${startTime(pid) ?? "?"}\n`;
}

function readLock(paths: RunPaths): { pid: number; start: string | null } | null {
	try {
		const [pid, start] = readFileSync(paths.lock, "utf8").trim().split(/\s+/);
		return { pid: Number(pid), start: start === undefined || start === "?" ? null : start };
	} catch {
		return null;
	}
}

/** The pid of a live lock holder, or null: alive, and (when the lock records it) started when the lock says. */
export function lockHolder(paths: RunPaths): number | null {
	const lock = readLock(paths);
	if (lock === null || !Number.isInteger(lock.pid) || lock.pid <= 0 || !alive(lock.pid)) return null;
	if (lock.start !== null && startTime(lock.pid) !== lock.start) return null;
	return lock.pid;
}

export class RunLocked extends Error {
	override readonly name = "RunLocked";
	readonly pid: number;
	constructor(paths: RunPaths, pid: number) {
		super(pid > 0 ? `run ${paths.id} is driven by process ${pid}` : `run ${paths.id} is being taken over by another process`);
		this.pid = pid;
	}
}

/**
 * Takes the lock for `pid` (default: this process), so two processes never
 * write one run. A lock already naming `pid` (with its start time) is
 * accepted. A stale lock (its holder is dead, or its pid now names another
 * process) is taken over under a takeover dir, created atomically, so of two
 * processes resuming a crashed run only one gets it.
 */
export function acquireLock(paths: RunPaths, pid = process.pid): () => void {
	mkdirSync(paths.dir, { recursive: true });
	const mine = lockText(pid);
	try {
		const fd = openSync(paths.lock, "wx");
		writeSync(fd, mine);
		closeSync(fd);
		return () => releaseLock(paths, pid);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const holder = lockHolder(paths);
	if (holder === pid) return () => releaseLock(paths, pid);
	if (holder !== null) throw new RunLocked(paths, holder);
	// Stale: one process takes it over. A takeover dir older than 10 s is a crashed takeover.
	const takeover = `${paths.lock}.takeover`;
	try {
		mkdirSync(takeover);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (Date.now() - statSync(takeover).mtimeMs < 10_000) throw new RunLocked(paths, 0);
		rmSync(takeover, { recursive: true, force: true });
		return acquireLock(paths, pid);
	}
	try {
		const now = lockHolder(paths);
		if (now !== null && now !== pid) throw new RunLocked(paths, now);
		const temp = `${paths.lock}.${process.pid}.tmp`;
		writeFileSync(temp, mine);
		renameSync(temp, paths.lock);
		return () => releaseLock(paths, pid);
	} finally {
		rmSync(takeover, { recursive: true, force: true });
	}
}

function releaseLock(paths: RunPaths, pid: number): void {
	if (readLock(paths)?.pid === pid) rmSync(paths.lock, { force: true });
}

/** When the oldest live run of a project took its lock (ms), or null: what `prune` must not race. */
export function oldestLiveLock(root: string): number | null {
	let oldest: number | null = null;
	for (const p of listRuns(root)) {
		if (lockHolder(p) === null) continue;
		const t = statSync(p.lock).mtimeMs;
		oldest = oldest === null ? t : Math.min(oldest, t);
	}
	return oldest;
}
