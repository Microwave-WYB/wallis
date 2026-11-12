// The caller API (docs/v2.md §7): run, attach, list, prune, and the Run
// handle. A run lives in its project's `.wallis/runs/<id>/`; the handle
// reads its log (the single source of truth) and talks to the process that
// drives it through files: the lock (who), the inbox (messages in), signals
// (stop).

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "typebox";
import { type CallId, type FailedCall, MessageRejected, NodeFailed } from "./errors.ts";
import type { Json } from "./host/core.ts";
import { readDialogue } from "./host/dialogues.ts";
import { acquireLock, listRuns, lockHolder, newRunId, oldestLiveLock, projectOf, RunLocked, type RunPaths, runPaths, runsDir } from "./host/runs.ts";
import { Store } from "./host/store.ts";
import { workflowDef } from "./nodes.ts";
import { importWorkflow, launch, notInRunner, processLog, readStart, type StartRequest, workflowName, writeStart } from "./launch.ts";
import type { Workflow } from "./runtime.ts";
import { type Duration, parseDuration, RunView, type Status, transcriptText } from "./status.ts";
import { type Address, declaredMedia, guessMedia, HostPath, type MessageId, refsIn, schemaErrors, stripPaths, toJson, walkMarked, withPaths } from "./values.ts";

export type Next<O> =
	| { readonly type: "message"; readonly outbox: string; readonly id: MessageId; readonly replyTo?: MessageId; readonly body: unknown }
	| { readonly type: "finished"; readonly output: O }
	| { readonly type: "failed"; readonly failed: readonly FailedCall[] }
	| { readonly type: "stopped" }
	| { readonly type: "timeout"; readonly progress: Status };

export interface Run<O> {
	readonly id: string;
	status(): Promise<Status>;
	tree(): Promise<unknown>;
	/** An agent call's dialogue, every attempt. */
	transcript(call: CallId): Promise<unknown>;
	/** The next outbox message, the end of the run, or `timeout` (harnesses cap background waits). */
	next(options?: { readonly timeout?: Duration }): Promise<Next<O>>;
	/** Send to a registered address; rejects with `MessageRejected` if the body does not match its schema. Persisted; a stopped run receives it on resume. */
	send(name: string, body: unknown, options?: { readonly replyTo?: MessageId; readonly interrupt?: boolean }): Promise<MessageId>;
	stop(): Promise<void>;
	/**
	 * Continue a stopped, crashed or failed run in place: the body runs again, finished calls are
	 * answered from the journal, failed ones run again as new attempts. `retry` also re-runs decided
	 * failures (`recovery: "retry"`): an agent that hit its turn budget continues its session with
	 * `turns` more turns (default: its budget again); an `output_invalid` agent continues with the
	 * errors as its next message. Only failed calls can be retried.
	 */
	resume(options?: { readonly detach?: boolean; readonly retry?: readonly CallId[]; readonly turns?: number }): Promise<Run<O>>;
	/** Waits for the end; throws NodeFailed on failure. */
	done(): Promise<Finished<O>>;
}

export interface Finished<O> extends Run<O> {
	readonly output: O;
	/** Copy the output's artifacts and Trees to a host directory. */
	exportOutput(hostDir: string): Promise<void>;
}

// runner.ts from source, runner.js from the built package (dist/).
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), `runner${extname(fileURLToPath(import.meta.url))}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A value as callers see it: refs with their host paths in the store. */
function hostView(store: Store, value: Json): unknown {
	return withPaths(value, (r) => {
		if (r.kind === "artifact") return store.blobPath(r.digest);
		const layers = store.treeLayers(r.digest);
		return layers === null || layers.length === 0 ? "" : store.layerDir(layers.at(-1)!);
	});
}

class RunHandle<O> implements Run<O> {
	readonly id: string;
	readonly paths: RunPaths;
	readonly root: string;
	readonly store: Store;
	#cursor = 0;
	/** A detached resume just started: the log's size then. Until the new process logs, the old ending is not the run's. */
	#resumedAt: number | null;

	constructor(root: string, paths: RunPaths, resumedAt: number | null = null) {
		this.root = root;
		this.paths = paths;
		this.id = paths.id;
		this.store = new Store(root);
		this.#resumedAt = resumedAt;
	}

	view(): RunView {
		const v = new RunView(this.paths);
		if (this.#resumedAt !== null) {
			const size = existsSync(this.paths.log) ? statSync(this.paths.log).size : 0;
			if (size > this.#resumedAt || !v.live) this.#resumedAt = null;
			else v.resuming = true;
		}
		return v;
	}

	async status(): Promise<Status> {
		return this.view().status(this.store);
	}

	async tree(): Promise<unknown> {
		return this.view().tree();
	}

	async transcript(call: CallId): Promise<unknown> {
		const v = this.view();
		const c = v.calls.find((x) => x.slot === call);
		if (!c) throw new Error(`run ${this.id} has no call ${call}`);
		if (c.kind !== "agent") throw new Error(`${c.name} is not an agent call`);
		const dialogues = v.dialogues(call);
		const last = dialogues.at(-1);
		const state = last ? (readDialogue(this.store, last) as { messages?: unknown[] } | undefined) : undefined;
		return { call: v.ref(c), messages: state?.messages ?? [], text: transcriptText(state?.messages ?? []) };
	}

	/** The failure as a NodeFailed: the first failed call. */
	#failure(v: RunView): NodeFailed {
		const f = v.failed(this.store)[0];
		if (!f) return new NodeFailed({ id: "workflow" as CallId, label: v.workflowLabel, path: [], attempt: 1 }, { type: "workflow_threw", message: "the run failed" });
		const { reason, recovery: _r, tail: _t, ...call } = f;
		return new NodeFailed(call, reason);
	}

	#finished(v: RunView, value: Json): Finished<O> {
		const output = hostView(this.store, value) as O;
		const store = this.store;
		return Object.assign(new RunHandle<O>(this.root, this.paths), {
			output,
			async exportOutput(hostDir: string): Promise<void> {
				exportRefs(store, value, hostDir);
			},
		}) as unknown as Finished<O>;
	}

	async next(options: { readonly timeout?: Duration } = {}): Promise<Next<O>> {
		const until = Date.now() + (options.timeout ? parseDuration(options.timeout) : 3_600_000);
		for (;;) {
			const v = this.view();
			const messages = v.outboxMessages();
			if (messages.length > this.#cursor) {
				const m = messages[this.#cursor++]!;
				return { type: "message", outbox: m.outbox, id: m.id as MessageId, ...(m.replyTo !== null ? { replyTo: m.replyTo as MessageId } : {}), body: hostView(this.store, m.body) };
			}
			const ended = v.ended;
			if (ended?.type === "done") return { type: "finished", output: hostView(this.store, ended.value) as O };
			if (ended?.type === "failed") return { type: "failed", failed: v.failed(this.store) };
			if (!v.live && !this.#starting()) return { type: "stopped" };
			if (Date.now() >= until) return { type: "timeout", progress: v.status(this.store) };
			await sleep(Math.min(250, Math.max(10, until - Date.now())));
		}
	}

	/** A detached run whose process has not taken its lock yet. */
	#starting(): boolean {
		const start = join(this.paths.dir, "start.json");
		// The child's pid is in the lock from the start: once it is gone, the run is not starting.
		return existsSync(start) && Date.now() - statSync(start).mtimeMs < 15_000 && !existsSync(this.paths.log) && (!existsSync(this.paths.lock) || lockHolder(this.paths) !== null);
	}

	async send(name: string, body: unknown, options: { readonly replyTo?: MessageId; readonly interrupt?: boolean } = {}): Promise<MessageId> {
		const v = this.view();
		const registered = v.facts[`registered:${name}`] as { address?: string; schema?: TSchema } | undefined;
		if (!registered?.address || !registered.schema) throw new Error(`run ${this.id} registered no address ${name}${Object.keys(v.facts).some((k) => k.startsWith("registered:")) ? ` (it has: ${Object.keys(v.facts).filter((k) => k.startsWith("registered:")).map((k) => k.slice(11)).join(", ")})` : ""}`);
		const to: Address<unknown> = { kind: "address", id: registered.address };
		const json = toJson(body);
		if (!json.ok) throw new MessageRejected(to, [{ path: "/", message: json.error }]);
		const errors = schemaErrors(registered.schema, stripPaths(json.value));
		if (errors.length > 0) throw new MessageRejected(to, errors);
		// A recipient that has ended reads nothing more: a finished run, a settled agent call, a closed actor.
		const closed = [{ path: "/", message: `${registered.address} is closed: it has ended and reads no more messages` }];
		if (v.ended?.type === "done") throw new MessageRejected(to, closed, "closed");
		if (registered.address.startsWith("agent:") && v.core.callState(registered.address.slice(6)) === "settled") throw new MessageRejected(to, closed, "closed");
		if (v.facts[`closed:${registered.address}`] === true) throw new MessageRejected(to, closed, "closed");
		const key = `caller:${randomUUID()}`;
		appendFileSync(join(this.paths.dir, "inbox.jsonl"), `${JSON.stringify({ key, name, body: stripPaths(json.value), ...(options.replyTo ? { replyTo: options.replyTo } : {}), ...(options.interrupt ? { interrupt: true } : {}) })}\n`);
		// A live run journals it within moments (its id comes from the journal), or rejects it (the
		// recipient closed meanwhile). A stopped one persists it and delivers it on resume.
		const rejectedFile = join(this.paths.dir, "inbox.rejected.jsonl");
		const rejection = () => {
			if (!existsSync(rejectedFile)) return null;
			for (const line of readFileSync(rejectedFile, "utf8").split("\n")) {
				if (!line) continue;
				const r = JSON.parse(line) as { key: string; reason: "invalid" | "closed"; errors: { path: string; message: string }[] };
				if (r.key === key) return r;
			}
			return null;
		};
		for (let i = 0; i < 120 && this.view().live; i++) {
			const id = this.view().core.sentId(key);
			if (id !== "") return id as MessageId;
			const r = rejection();
			if (r) throw new MessageRejected(to, r.errors, r.reason);
			await sleep(50);
		}
		const id = this.view().core.sentId(key);
		return (id !== "" ? id : key) as MessageId;
	}

	async stop(): Promise<void> {
		const pid = lockHolder(this.paths);
		if (pid === null) return;
		if (pid === process.pid) throw new Error(`run ${this.id} is driven by this process; it stops when its body ends`);
		process.kill(pid, "SIGTERM");
		for (let i = 0; i < 100 && lockHolder(this.paths) !== null; i++) await sleep(100);
		if (lockHolder(this.paths) !== null) process.kill(pid, "SIGKILL");
		for (let i = 0; i < 50 && lockHolder(this.paths) !== null; i++) await sleep(100);
	}

	async resume(options: { readonly detach?: boolean; readonly retry?: readonly CallId[]; readonly turns?: number } = {}): Promise<Run<O>> {
		const holder = lockHolder(this.paths);
		if (holder !== null) throw new RunLocked(this.paths, holder);
		const v = this.view();
		const wf = v.facts.workflow as { file: string; digest: string; name: string | null } | undefined;
		if (!wf) throw new Error(`run ${this.id} has no record of its workflow`);
		const retry = options.retry ?? [];
		for (const id of retry) {
			const c = v.calls.find((x) => x.slot === id);
			if (!c) throw new Error(`run ${this.id} has no call ${id}`);
			if (c.attempts.at(-1)?.type !== "failed") throw new Error(`${c.name} did not fail: only failed calls can be retried (to redo a finished one, start a new run)`);
		}
		const resume = { retry: [...retry], turns: options.turns ?? null };
		const input = "input" in v.snapshot ? v.snapshot.input : null;
		if (options.detach) {
			const size = existsSync(this.paths.log) ? statSync(this.paths.log).size : 0;
			detach(this.paths, { module: wf.file, digest: wf.digest, name: wf.name, input, resume });
			this.#resumedAt = size;
			return new RunHandle<O>(this.root, this.paths, size);
		}
		const def = await importWorkflow(wf.file, wf.digest, wf.name);
		const { result } = await launch({ root: this.root, paths: this.paths, def, input, resume });
		await result;
		const after = this.view();
		const ended = after.ended;
		if (ended?.type === "done") return this.#finished(after, ended.value);
		return new RunHandle<O>(this.root, this.paths);
	}

	async done(): Promise<Finished<O>> {
		for (;;) {
			const v = this.view();
			const ended = v.ended;
			if (ended?.type === "done") return this.#finished(v, ended.value);
			if (ended?.type === "failed") throw this.#failure(v);
			if (!v.live && !this.#starting()) throw new Error(`run ${this.id} is stopped; resume it (attach(…).resume())`);
			await sleep(250);
		}
	}

	finishedNow(): Finished<O> {
		const v = this.view();
		const ended = v.ended;
		if (ended?.type === "done") return this.#finished(v, ended.value);
		throw this.#failure(v);
	}
}

/** Copies every artifact and Tree in a value to a host dir (Trees as subdirs named by digest). */
function exportRefs(store: Store, value: Json, dir: string): void {
	mkdirSync(dir, { recursive: true });
	const used = new Map<string, string>();
	for (const r of refsIn(value)) {
		if (r.kind === "artifact") {
			let name = basename(String(r.name));
			const prior = used.get(name);
			if (prior !== undefined && prior !== r.digest) name = `${basename(name, extname(name))}-${r.digest.slice(7, 15)}${extname(name)}`;
			used.set(name, r.digest);
			cpSync(store.blobPath(r.digest), join(dir, name));
		} else {
			const target = join(dir, r.digest.slice(7, 19));
			for (const l of store.treeLayers(r.digest) ?? []) spawnSync("cp", ["-a", "--reflink=auto", "-T", store.layerDir(l), target]);
		}
	}
}

/** Host files the caller named (`Artifact.from`, `Tree.from`), ingested into the store: the input as the journal keeps it. */
function ingest(store: Store, schema: TSchema, value: unknown): Json {
	const one = (h: HostPath, media: string | undefined): unknown => {
		if (!existsSync(h.host)) throw new Error(`${h.kind === "tree" ? "Tree" : "Artifact"}.from: ${h.host} does not exist`);
		if (h.kind === "tree") return { kind: "tree", digest: store.snapshot(h.host, { move: false }) };
		const name = h.name ?? basename(h.host);
		return { kind: "artifact", digest: store.ingestFile(h.host, { move: false }), name, media: h.media ?? media ?? guessMedia(name) };
	};
	const marked = walkMarked(schema, value, (mark, node, v) => (v instanceof HostPath ? one(v, mark === "artifact" ? declaredMedia(node) : undefined) : v));
	const rest = (v: unknown): unknown => (v instanceof HostPath ? one(v, undefined) : Array.isArray(v) ? v.map(rest) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rest(x)])) : v);
	const json = toJson(rest(marked));
	if (!json.ok) throw new Error(`the input is not JSON: ${json.error}`);
	return stripPaths(json.value);
}

function detach(paths: RunPaths, request: StartRequest): void {
	writeStart(paths, request);
	const out = openSync(join(paths.dir, "process.log"), "a");
	const child = spawn(process.execPath, [RUNNER, paths.dir], { detached: true, stdio: ["ignore", out, out], env: process.env });
	closeSync(out);
	// The lock names the child at once, so no one sees the run as stopped while it starts.
	if (child.pid !== undefined) acquireLock(paths, child.pid);
	child.unref();
	processLog(paths, `started process ${child.pid}`);
}

/** Run in the foreground and wait for the output. */
export function run<IS extends TSchema, OS extends TSchema, M>(wf: Workflow<IS, OS, M>, input: Static<IS>): Promise<Finished<Static<OS>>>;
/** Start a detached run (its own process) and return at once. */
export function run<IS extends TSchema, OS extends TSchema, M>(wf: Workflow<IS, OS, M>, input: Static<IS>, options: { readonly detach: true; readonly onExit?: string }): Promise<Run<Static<OS>>>;
export async function run<IS extends TSchema, OS extends TSchema, M>(wf: Workflow<IS, OS, M>, input: Static<IS>, options?: { readonly detach: true; readonly onExit?: string }): Promise<Run<Static<OS>> | Finished<Static<OS>>> {
	notInRunner();
	const def = workflowDef(wf);
	if (!def.site.file) throw new Error("this workflow has no definition site (define it in a module with workflow({...}))");
	const root = projectOf(def.site.file);
	const store = new Store(root);
	const value = ingest(store, def.input, input);
	const errors = schemaErrors(def.input, value);
	if (errors.length > 0) throw new Error(`the input does not match the workflow's schema: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
	const paths = runPaths(join(runsDir(root), newRunId(workflowName(def))));
	const handle = new RunHandle<Static<OS>>(root, paths);
	if (options?.detach) {
		detach(paths, { module: def.site.file, digest: def.digest, name: def.site.name, input: value, ...(options.onExit ? { onExit: options.onExit } : {}) });
		return handle;
	}
	const { result } = await launch({ root, paths, def, input: value });
	await result;
	return handle.finishedNow();
}

function findRun(id: string, from: string): { root: string; paths: RunPaths } {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		const candidate = join(runsDir(dir), id);
		if (existsSync(candidate)) return { root: dir, paths: runPaths(candidate) };
		if (dirname(dir) === dir) break;
	}
	throw new Error(`no run ${id} in a .wallis/runs above ${from}`);
}

export function attach(id: string): Run<unknown>;
export function attach<IS extends TSchema, OS extends TSchema, M>(wf: Workflow<IS, OS, M>, id: string): Run<Static<OS>>;
export function attach(a: unknown, b?: string): Run<unknown> {
	if (typeof a === "string") {
		const { root, paths } = findRun(a, process.cwd());
		return new RunHandle(root, paths);
	}
	const def = workflowDef(a as Workflow);
	const { root, paths } = findRun(b!, dirname(def.site.file));
	return new RunHandle(root, paths);
}

export async function list(workflowFile: string): Promise<readonly { readonly id: string; readonly state: Status["state"]; readonly started: string }[]> {
	const file = resolve(workflowFile);
	const root = projectOf(file);
	return listRuns(root).flatMap((p) => {
		const v = new RunView(p);
		const wf = v.facts.workflow as { file?: string } | undefined;
		return wf?.file === file ? [{ id: p.id, state: v.state, started: String(v.facts.created ?? "") }] : [];
	});
}

/** Delete store data no remaining run references. */
export async function prune(): Promise<{ readonly freed: number }> {
	const root = projectOf(join(process.cwd(), "x"));
	const runs = listRuns(root);
	const store = new Store(root);
	const r = store.prune(runs.map((p) => p.log).concat(runs.map((p) => join(p.dir, "start.json"))), oldestLiveLock(root));
	return { freed: r.bytes };
}

/** For the detached runner. */
export { readStart, launch, importWorkflow };
export function runIdsIn(root: string): string[] {
	return existsSync(runsDir(root)) ? readdirSync(runsDir(root)) : [];
}
