// Reading runs without driving them: status from a refold of the log, the
// derived `stopped`, what needs attention, and agent-readable summaries.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, Json } from "../sdk/index.ts";
import { blobPath, nodeDirName, refsIn, shareBlobs } from "./artifacts.ts";
import { Core, type Event, type IdleReason, type Outcome, type Refusal, type Snapshot } from "./core.ts";
import { EventLog } from "./log.ts";
import { mayControl, type Owner, ownerAlive } from "./owner.ts";
import { acquireLock, listRuns, lockHolder, readMeta, type RunPaths, runPaths, writeMeta } from "./store.ts";

export interface RunView {
	readonly runId: string;
	readonly workflow: string | null;
	readonly run: Snapshot;
	/** Not finished and no live host drives it: resumable. Derived, never logged. */
	readonly stopped: boolean;
	readonly driver: number | null;
	readonly events: number;
	readonly owner: string | null;
	/** The owner still exists (a harness process that is still running, or the human). */
	readonly ownerAlive: boolean;
}

export function inspectRun(dir: string): RunView {
	const paths = runPaths(dir);
	const events = new EventLog(paths.log).read();
	const run = Core.refold(events).snapshot();
	const driver = lockHolder(paths);
	const meta = readMeta(paths);
	return {
		runId: paths.id,
		workflow: meta ? workflowName(meta.workflow) : null,
		run,
		stopped: run.status !== null && run.status.type !== "finished" && driver === null,
		driver,
		events: events.length,
		owner: run.owner ?? null,
		ownerAlive: ownerAlive(run.owner ?? null),
	};
}

function workflowName(path: string): string {
	const parts = path.split("/");
	return parts.at(-1) === "workflow.ts" ? parts.at(-2)! : parts.at(-1)!;
}

export type Attention =
	| { readonly kind: "node_idle"; readonly runId: string; readonly node: string; readonly agent: string; readonly message: string }
	| { readonly kind: "run_idle"; readonly runId: string; readonly reason: IdleReason }
	| { readonly kind: "finished"; readonly runId: string; readonly outcome: Outcome }
	| { readonly kind: "stopped"; readonly runId: string };

/** What a human or harness should look at in this run, in a stable order. */
export function attention(view: RunView): Attention[] {
	const items: Attention[] = [];
	const status = view.run.status;
	if (status?.type === "finished") return [{ kind: "finished", runId: view.runId, outcome: status.outcome }];
	for (const node of view.run.nodes) {
		if (node.status.type === "node_idle") {
			items.push({ kind: "node_idle", runId: view.runId, node: node.id, agent: node.agent, message: node.status.last_message });
		}
	}
	if (status?.type === "idle" && status.reason) items.push({ kind: "run_idle", runId: view.runId, reason: status.reason });
	if (view.stopped && status?.type === "running") items.push({ kind: "stopped", runId: view.runId });
	return items;
}

export function attentionKey(item: Attention): string {
	switch (item.kind) {
		case "node_idle":
			return `${item.runId} node ${item.node} ${item.message}`;
		case "run_idle":
			return `${item.runId} idle ${JSON.stringify(item.reason)}`;
		default:
			return `${item.runId} ${item.kind}`;
	}
}

/** Idle nodes and idle runs under `root`, of runs the caller controls (all of them when no caller is given). */
export function pending(root: string, caller?: Owner): Attention[] {
	return listRuns(root)
		.map((p) => inspectRun(p.dir))
		.filter((v) => caller === undefined || mayControl(caller, v.owner))
		.map((v) => attention(v))
		.flat()
		.filter((a) => a.kind === "node_idle" || a.kind === "run_idle");
}

/** Unfinished runs whose owner is gone (or never set): anyone may claim them. */
export function claimable(root: string): RunView[] {
	return listRuns(root)
		.map((p) => inspectRun(p.dir))
		.filter((v) => v.run.status?.type !== "finished" && !v.ownerAlive);
}

function describeReason(reason: IdleReason): string {
	switch (reason.type) {
		case "budget_exhausted":
			return `the ${reason.kind} budget is spent (${reason.spent} of ${reason.limit})`;
		case "executor_unavailable":
			return `the executor cannot serve model alias ${reason.alias}: ${reason.error}`;
		case "paused_by_user":
			return "its owner paused it";
	}
}

/** Notifications carry content, truncated. */
export const MESSAGE_CAP = 1200;
export const RESULT_CAP = 600;

export function truncate(text: string, cap: number): string {
	return text.length <= cap ? text : `${text.slice(0, cap)}… [${text.length - cap} more chars]`;
}

function describeOutcome(outcome: Outcome): string {
	switch (outcome.type) {
		case "done":
			return `done: ${truncate(JSON.stringify(outcome.value), RESULT_CAP)}`;
		case "cancelled":
			return "cancelled";
		case "failed":
			return `failed: ${truncate(JSON.stringify(outcome.reason), RESULT_CAP)}`;
	}
}

/** One paragraph per item, with the command that answers it. */
export function describe(items: readonly Attention[]): string {
	return items
		.map((item) => {
			switch (item.kind) {
				case "node_idle":
					return [
						`Run ${item.runId}: node ${item.node} (${item.agent}) is waiting for a reply:`,
						...truncate(item.message, MESSAGE_CAP)
							.split("\n")
							.map((l) => `  > ${l}`),
						`Reply with: npx wallis send ${item.runId} '${item.node}' "<your reply>"`,
					].join("\n");
				case "run_idle":
					return [
						`Run ${item.runId} is paused: ${describeReason(item.reason)}.`,
						item.reason.type === "budget_exhausted"
							? `Raise it with: npx wallis resume ${item.runId} --budget ${item.reason.kind === "compute_minutes" ? "computeMinutes" : item.reason.kind}=<new limit>`
							: item.reason.type === "executor_unavailable"
								? `Fix the executor or rebind the alias, then: npx wallis resume ${item.runId} --model ${item.reason.alias}=<provider/model:thinking>`
								: `Continue it with: npx wallis resume ${item.runId}`,
					].join("\n");
				case "finished":
					return `Run ${item.runId} finished, ${describeOutcome(item.outcome)}.`;
				case "stopped":
					return `Run ${item.runId} stopped: no process drives it. Resume with: npx wallis resume ${item.runId}`;
			}
		})
		.join("\n\n");
}

/**
 * Blocks until something new needs attention: a node goes idle that was not
 * idle when the wait began, or the whole run is finished, idle or stopped
 * (reported at once, since waiting on those would never end). Returns null
 * on timeout.
 */
export async function waitForAttention(dir: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<Attention[] | null> {
	const start = Date.now();
	const baseline = new Set(attention(inspectRun(dir)).filter((a) => a.kind === "node_idle").map(attentionKey));
	for (;;) {
		const view = inspectRun(dir);
		const items = attention(view);
		const whole = view.run.status?.type !== "running" || view.stopped;
		if (whole && items.length > 0) return items;
		const fresh = items.filter((a) => !baseline.has(attentionKey(a)));
		if (fresh.length > 0) return items;
		if (options.timeoutMs !== undefined && Date.now() - start >= options.timeoutMs) return null;
		await new Promise((r) => setTimeout(r, options.pollMs ?? 200));
	}
}

/**
 * Copies a prefix of a run's log into a new run. `at` is a count of events
 * or a node id; a node id keeps the events up to and including that node's
 * request, so the fork issues it again. The original is untouched.
 */
export function forkRun(source: string, target: string, at: number | string): RunPaths {
	const from = runPaths(source);
	const to = runPaths(target);
	if (existsSync(to.log)) throw new Error(`run ${to.id} already exists`);
	const events = new EventLog(from.log).read();
	let count: number;
	if (typeof at === "number") count = at;
	else {
		const index = events.findIndex((e: Event) => e.type === "requested" && e.id === at);
		if (index < 0) throw new Error(`run ${from.id} has no node ${at}`);
		count = index + 1;
	}
	if (count < 1 || count > events.length) throw new Error(`fork point ${at} is outside the log (1..${events.length})`);
	mkdirSync(to.dir, { recursive: true });
	writeFileSync(to.log, events.slice(0, count).map((e) => `${JSON.stringify(e)}\n`).join(""));
	const meta = readMeta(from);
	if (meta) writeMeta(to, { ...meta, run_id: to.id, created: new Date().toISOString(), forked_from: { run_id: from.id, at: count } });
	shareBlobs(from.dir, to.dir);
	return to;
}

/** Every artifact a run's log refers to, in first-seen order. */
export function artifactsOf(dir: string): ArtifactRef[] {
	return refsIn(new EventLog(runPaths(dir).log).read() as unknown as Json);
}

/**
 * Copies one artifact out of a run, selected by digest (or a prefix of its
 * hex) or by name, into `target/<name>`. Promoting artifacts across runs is
 * the main agent's job; this is the only way out.
 */
export function exportArtifact(dir: string, selector: string, target: string): string {
	const refs = artifactsOf(dir);
	const hex = selector.replace(/^sha256:/, "");
	const matches = refs.filter((r) => r.name === selector || r.digest.slice("sha256:".length).startsWith(hex));
	const digests = new Set(matches.map((m) => m.digest));
	if (digests.size === 0) throw new Error(`run ${runPaths(dir).id} has no artifact ${selector}`);
	if (digests.size > 1) throw new Error(`artifact ${selector} is ambiguous: ${[...digests].join(", ")}`);
	const ref = matches[0]!;
	mkdirSync(target, { recursive: true });
	const path = join(target, ref.name);
	copyFileSync(blobPath(runPaths(dir).dir, ref.digest), path);
	return path;
}

/**
 * Applies a control event (a claim) to a run no process drives: takes the
 * lock, refolds, steps the core and appends the event if it is accepted.
 */
export function applyControl(dir: string, event: Event): Refusal | null {
	const paths = runPaths(dir);
	const release = acquireLock(paths);
	try {
		const log = new EventLog(paths.log);
		const core = Core.refold(log.read());
		const effects = core.step(event);
		const refused = effects.find((e) => e.type === "refuse");
		if (refused && refused.type === "refuse") return refused.refusal;
		if (effects.some((e) => e.type === "checkpoint")) log.append(event);
		return null;
	} finally {
		release();
	}
}

/**
 * Waits on every unfinished run the caller controls: returns when one of
 * them needs attention (as `waitForAttention` decides), or null on timeout.
 */
export async function waitForOwn(root: string, caller: Owner, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<Attention[] | null> {
	const start = Date.now();
	const own = () => listRuns(root).map((p) => inspectRun(p.dir)).filter((v) => mayControl(caller, v.owner) && v.run.status?.type !== "finished");
	const watched = new Set(own().map((v) => v.runId));
	const baseline = new Set(own().flatMap((v) => attention(v).filter((a) => a.kind === "node_idle").map(attentionKey)));
	for (;;) {
		const views = listRuns(root)
			.map((p) => inspectRun(p.dir))
			.filter((v) => watched.has(v.runId) || (mayControl(caller, v.owner) && v.run.status?.type !== "finished"));
		for (const v of views) watched.add(v.runId);
		const items = views.flatMap((v) => {
			const all = attention(v);
			const whole = v.run.status?.type !== "running" || v.stopped;
			return whole ? all : all.filter((a) => !baseline.has(attentionKey(a)));
		});
		if (items.length > 0) return items;
		if (options.timeoutMs !== undefined && Date.now() - start >= options.timeoutMs) return null;
		await new Promise((r) => setTimeout(r, options.pollMs ?? 200));
	}
}

// --- Monitoring ------------------------------------------------------------------

/** Every run under `root`, oldest first. */
export function listRunViews(root: string): RunView[] {
	return listRuns(root).map((p) => inspectRun(p.dir));
}

/** One line per run, for `wallis ls` and `list_runs`. */
export function runLine(v: RunView): string {
	const status = v.run.status?.type ?? "unknown";
	const reason = v.run.status?.type === "idle" && v.run.status.reason ? ` (${v.run.status.reason.type})` : "";
	const outcome = v.run.status?.type === "finished" ? ` (${v.run.status.outcome.type})` : "";
	return `${v.runId}  ${v.workflow ?? "?"}  ${status}${reason}${outcome}${v.stopped ? ", stopped" : ""}  owner=${v.owner ?? "none"}${v.owner && !v.ownerAlive ? " (gone)" : ""}`;
}

/**
 * The run's nodes as a tree: request ids encode branches (`#2.a#0`) and
 * sub-workflows (`#3>retry#0`), so depth is the number of nested segments.
 */
export function renderTree(v: RunView): string {
	const lines = [runLine(v)];
	for (const node of v.run.nodes) {
		const depth = (node.id.match(/[.>]/g) ?? []).length;
		const status =
			node.status.type === "node_idle"
				? `idle: ${truncate(node.status.last_message, 80)}`
				: node.status.type === "node_done"
					? `done (${node.status.outcome.type})`
					: "running";
		lines.push(`${"  ".repeat(depth + 1)}${node.id}  ${node.agent}  ${node.model}  ${status}`);
	}
	return lines.join("\n");
}

export const PAGE_CAP = 200;
const ENTRY_CAP = 2000;

export interface Page<T> {
	readonly items: T[];
	/** Pass back as `since` for the next page; equal to the total when there is no more. */
	readonly next: number;
	readonly total: number;
}

function page<T>(all: readonly T[], since: number | undefined, limit: number | undefined): Page<T> {
	const from = Math.max(0, since ?? 0);
	const n = Math.min(PAGE_CAP, Math.max(1, limit ?? 50));
	const items = all.slice(from, from + n);
	return { items, next: from + items.length, total: all.length };
}

/** The run's event log from `since` (an event index), capped. */
export function runLog(dir: string, since?: number, limit?: number): Page<{ seq: number; event: string }> {
	const events = new EventLog(runPaths(dir).log).read();
	return page(
		events.map((e, i) => ({ seq: i, event: truncate(JSON.stringify(e), ENTRY_CAP) })),
		since,
		limit,
	);
}

/** A node's observational transcript (messages, tool calls and results), capped. */
export function nodeTranscript(dir: string, node: string, since?: number, limit?: number): Page<{ seq: number; entry: string }> {
	const file = join(runPaths(dir).dir, "nodes", `${nodeDirName(node)}.jsonl`);
	const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
	return page(
		lines.map((l, i) => ({ seq: i, entry: truncate(l, ENTRY_CAP) })),
		since,
		limit,
	);
}
