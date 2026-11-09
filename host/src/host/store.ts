// Where runs live and who drives them.
//
// A run is a directory, by default `.wallis/runs/<run_id>/` under the
// project root:
//   log.jsonl    the append-only event log (the run is a fold over it)
//   meta.json    workflow path, project root, executor module
//   lock         the pid of the host process driving the run
//   inbox.jsonl  interventions for a run another process drives (.done: taken, .refused: refused)
//
// The lock makes `stopped` derivable: a run that is not finished and has no
// live lock holder is stopped, and resumable. That is computed at query
// time and never logged.

import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Json, Refusal } from "../sdk/index.ts";

export interface RunPaths {
	readonly dir: string;
	readonly id: string;
	readonly log: string;
	readonly meta: string;
	readonly lock: string;
	readonly inbox: string;
}

export function runPaths(dir: string): RunPaths {
	const abs = resolve(dir);
	return {
		dir: abs,
		id: basename(abs),
		log: join(abs, "log.jsonl"),
		meta: join(abs, "meta.json"),
		lock: join(abs, "lock"),
		inbox: join(abs, "inbox.jsonl"),
	};
}

export function runsDir(root: string): string {
	return join(resolve(root), ".wallis", "runs");
}

/** `<workflow>-<utc stamp>-<random>`: sortable and unique enough for one machine. */
export function newRunId(workflow: string, now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
	return `${workflow}-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function listRuns(root: string): RunPaths[] {
	const dir = runsDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.sort()
		.map((id) => runPaths(join(dir, id)))
		.filter((p) => existsSync(p.log));
}

// --- Meta ----------------------------------------------------------------------

export interface RunMeta {
	readonly run_id: string;
	readonly workflow: string;
	readonly root: string;
	/** Module whose default export creates the executor and script runner. */
	readonly executor: string | null;
	readonly created: string;
	readonly forked_from?: { readonly run_id: string; readonly at: number };
	/** Every required binary: the absolute path resolved at run creation (reused on resume), and its version. */
	readonly bins?: Readonly<Record<string, { readonly path: string; readonly version?: string }>>;
	/** The host base the sandboxes run on. */
	readonly base?: { readonly distro: string; readonly kernel: string };
	/** Whether the run's sandboxes were built with bwrap. */
	readonly confined?: boolean;
	/** Answer schemas of the workflow's orchestrator nodes, for pending items. */
	readonly answers?: Readonly<Record<string, Json>>;
	/** Parameters for the first session of a run started detached. */
	readonly start?: {
		readonly input?: Json;
		readonly seed?: number;
		readonly models?: Readonly<Record<string, string>>;
		readonly mounts?: Readonly<Record<string, string>>;
		readonly bins?: Readonly<Record<string, string>>;
		readonly callerPath?: string;
		readonly owner?: string;
	};
}

export function readMeta(paths: RunPaths): RunMeta | null {
	return existsSync(paths.meta) ? (JSON.parse(readFileSync(paths.meta, "utf8")) as RunMeta) : null;
}

export function writeMeta(paths: RunPaths, meta: RunMeta): void {
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
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

/** The pid of a live lock holder, or null. */
export function lockHolder(paths: RunPaths): number | null {
	if (!existsSync(paths.lock)) return null;
	const pid = Number(readFileSync(paths.lock, "utf8").trim());
	return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}

export class RunLocked extends Error {
	override readonly name = "RunLocked";
	readonly pid: number;
	constructor(paths: RunPaths, pid: number) {
		super(`run ${paths.id} is driven by process ${pid}`);
		this.pid = pid;
	}
}

/**
 * Takes the lock for `pid` (default: this process). A lock held by a dead
 * process is stale and taken over; a lock already naming `pid` (written by a
 * parent that spawned this driver) is accepted.
 */
export function acquireLock(paths: RunPaths, pid = process.pid): () => void {
	mkdirSync(paths.dir, { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(paths.lock, "wx");
			writeSync(fd, `${pid}\n`);
			closeSync(fd);
			return () => releaseLock(paths, pid);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = lockHolder(paths);
			if (holder === pid) return () => releaseLock(paths, pid);
			if (holder !== null) throw new RunLocked(paths, holder);
			rmSync(paths.lock, { force: true });
		}
	}
	throw new Error(`could not lock run ${paths.id}`);
}

function releaseLock(paths: RunPaths, pid: number): void {
	if (existsSync(paths.lock) && Number(readFileSync(paths.lock, "utf8").trim()) === pid) rmSync(paths.lock, { force: true });
}

// --- Inbox ---------------------------------------------------------------------

/** An intervention from another process. Each carries `by`, checked when the driver applies it. */
export type InboxEntry =
	/** Delivered if the node is idle, queued as a steer if it is running: decided when the driver applies it. */
	| { readonly id: string; readonly type: "send"; readonly node: string; readonly text: string; readonly by: string; readonly turns?: number }
	| { readonly id: string; readonly type: "interrupt"; readonly node: string; readonly by: string }
	| { readonly id: string; readonly type: "submit"; readonly node: string; readonly value: Json; readonly by: string }
	| { readonly id: string; readonly type: "restart"; readonly node: string; readonly note?: string; readonly by: string; readonly turns?: number }
	| { readonly id: string; readonly type: "cancel_node"; readonly node: string; readonly by: string }
	| { readonly id: string; readonly type: "cancel"; readonly by: string }
	| { readonly id: string; readonly type: "pause"; readonly by: string }
	| { readonly id: string; readonly type: "resume"; readonly by: string }
	| { readonly id: string; readonly type: "claim"; readonly owner: string };

export function newMessageId(): string {
	return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function appendInbox(paths: RunPaths, entry: InboxEntry): void {
	mkdirSync(paths.dir, { recursive: true });
	appendFileSync(paths.inbox, `${JSON.stringify(entry)}\n`);
}

export function readInbox(paths: RunPaths): InboxEntry[] {
	if (!existsSync(paths.inbox)) return [];
	const lines = readFileSync(paths.inbox, "utf8").split("\n");
	return lines
		.slice(0, -1)
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as InboxEntry);
}

/** The refusal the driver recorded for an inbox entry, if it refused it. */
export function refusedEntry(paths: RunPaths, id: string): Refusal | null {
	const file = `${paths.inbox}.refused`;
	if (!existsSync(file)) return null;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		const entry = JSON.parse(line) as { id: string; refusal: Refusal };
		if (entry.id === id) return entry.refusal;
	}
	return null;
}
