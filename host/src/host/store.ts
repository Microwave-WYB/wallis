// Where runs live and who drives them.
//
// A run is a directory, by default `.wallis/runs/<run_id>/` under the
// project root:
//   log.jsonl    the append-only event log (the run is a fold over it)
//   blobs/       content-addressed values the log names (artifacts, dialogues)
//   meta.json    a cache: the host facts the log notes (`noted` events), with the
//                log size it was derived at; rebuilt from the log when stale
//   start.json   the launch request of `wallis run` (before any host): the first
//                session's parameters, written once
//   lock         the pid of the host process driving the run
//   inbox.jsonl  interventions for a run another process drives (.done: taken, .refused: refused)
//
// The lock makes `stopped` derivable: a run that is not finished and has no
// live lock holder is stopped, and resumable. That is computed at query
// time and never logged.

import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { Json, Refusal } from "../sdk/index.ts";
import { Core } from "./core.ts";
import { EventLog } from "./log.ts";

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

/** Host facts the log notes (`noted` events), checked when read back. */
const Facts = Type.Object({
	workflow: Type.String(),
	root: Type.String(),
	/** Module whose default export creates the executor and script runner. */
	executor: Type.Union([Type.String(), Type.Null()]),
	created: Type.String(),
	forked_from: Type.Optional(Type.Object({ run_id: Type.String(), at: Type.Integer() })),
	/** Every required binary: the absolute path resolved at run creation (reused on resume), and its version. */
	bins: Type.Optional(Type.Record(Type.String(), Type.Object({ path: Type.String(), version: Type.Optional(Type.String()) }))),
	/** The host base the sandboxes run on. */
	base: Type.Optional(Type.Object({ distro: Type.String(), kernel: Type.String() })),
	/** Whether the run's sandboxes were built with bwrap. */
	confined: Type.Optional(Type.Boolean()),
	/** Preflight warnings: agent tools that may write outside, tools a server leaves out. */
	warnings: Type.Optional(Type.Array(Type.String())),
	/** Answer schemas of the workflow's orchestrator nodes, for pending items. */
	answers: Type.Optional(Type.Record(Type.String(), Type.Unsafe<Json>({}))),
	/** Host dirs the caller gave for bind volumes (`--volume`), by container target: reused on resume. */
	volumes: Type.Optional(Type.Record(Type.String(), Type.String())),
	/** Each toolset's bundle digest (its module and the runner, as run), by path. */
	toolsets: Type.Optional(Type.Record(Type.String(), Type.String())),
});

/** Parameters for the first session of a run started by `wallis run`. */
const Start = Type.Object({
	input: Type.Optional(Type.Unsafe<Json>({})),
	seed: Type.Optional(Type.Number()),
	models: Type.Optional(Type.Record(Type.String(), Type.String())),
	volumes: Type.Optional(Type.Record(Type.String(), Type.String())),
	bins: Type.Optional(Type.Record(Type.String(), Type.String())),
	callerPath: Type.Optional(Type.String()),
	owner: Type.Optional(Type.String()),
});

/** The launch request: what the first host notes, and how it starts. */
const Launch = Type.Object({ workflow: Type.String(), root: Type.String(), executor: Type.Union([Type.String(), Type.Null()]), created: Type.String(), start: Type.Optional(Start) });
export type Launch = Static<typeof Launch>;

export type RunMeta = Static<typeof Facts> & { readonly run_id: string; readonly start?: Static<typeof Start> };

/** Writes `start.json` once, atomically, before any host runs. */
export function writeLaunch(paths: RunPaths, launch: Launch): void {
	mkdirSync(paths.dir, { recursive: true });
	writeAtomic(join(paths.dir, "start.json"), `${JSON.stringify(launch, null, 2)}\n`);
}

function readLaunch(paths: RunPaths): Launch | null {
	const file = join(paths.dir, "start.json");
	if (!existsSync(file)) return null;
	const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!Value.Check(Launch, raw)) throw new Error(`${file} is not a launch request`);
	return raw;
}

const Cache = Type.Object({ log_bytes: Type.Integer(), meta: Facts });

/** The cached metadata, or null when there is none (or another process just replaced it). */
function readCache(file: string): Static<typeof Cache> | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const raw: unknown = JSON.parse(text);
	return Value.Check(Cache, raw) ? raw : null;
}

function writeAtomic(file: string, text: string): void {
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temp, text);
	renameSync(temp, file);
}

/**
 * The run's metadata: derived from the facts its log notes, else (before a
 * host has run) from its launch request. `meta.json` caches it with the log
 * size it was derived at, written atomically; a stale cache is rebuilt.
 */
export function readMeta(paths: RunPaths): RunMeta | null {
	const launch = readLaunch(paths);
	const start = launch?.start === undefined ? {} : { start: launch.start };
	const size = existsSync(paths.log) ? statSync(paths.log).size : 0;
	if (size === 0) return launch ? { run_id: paths.id, workflow: launch.workflow, root: launch.root, executor: launch.executor, created: launch.created, ...start } : null;
	const cached = readCache(paths.meta);
	if (cached !== null && cached.log_bytes === size) return { ...cached.meta, run_id: paths.id, ...start };
	const facts = Core.refold(new EventLog(paths.log).read()).facts();
	if (Object.keys(facts).length === 0) return launch ? { run_id: paths.id, workflow: launch.workflow, root: launch.root, executor: launch.executor, created: launch.created, ...start } : null;
	if (!Value.Check(Facts, facts)) throw new Error(`run ${paths.id}: the facts its log notes are malformed: ${[...Value.Errors(Facts, facts)].map((e) => `${e.instancePath} ${e.message}`).join("; ")}`);
	writeAtomic(paths.meta, `${JSON.stringify({ log_bytes: size, meta: facts }, null, 2)}\n`);
	return { ...facts, run_id: paths.id, ...start };
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

/**
 * A host that cannot boot (its run is refused) refuses every inbox entry it
 * has not taken, with that refusal: whoever handed it in learns why,
 * instead of entries piling up unanswered.
 */
export function refusePending(paths: RunPaths, refusal: Refusal): void {
	const done = new Set(existsSync(`${paths.inbox}.done`) ? readFileSync(`${paths.inbox}.done`, "utf8").split("\n") : []);
	for (const entry of readInbox(paths)) {
		if (done.has(entry.id) || refusedEntry(paths, entry.id) !== null) continue;
		appendFileSync(`${paths.inbox}.refused`, `${JSON.stringify({ id: entry.id, refusal })}\n`);
	}
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
