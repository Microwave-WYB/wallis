// Reading runs without driving them: status from a refold of the log, the
// derived `stopped`, what needs attention, and agent-readable summaries.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Core, type Event, type IdleReason, type Outcome, type Snapshot } from "./core.ts";
import { EventLog } from "./log.ts";
import { listRuns, lockHolder, readMeta, type RunPaths, runPaths, writeMeta } from "./store.ts";

export interface RunView {
	readonly runId: string;
	readonly workflow: string | null;
	readonly run: Snapshot;
	/** Not finished and no live host drives it: resumable. Derived, never logged. */
	readonly stopped: boolean;
	readonly driver: number | null;
	readonly events: number;
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

/** Idle nodes and idle runs under `root`. */
export function pending(root: string): Attention[] {
	return listRuns(root)
		.map((p) => attention(inspectRun(p.dir)))
		.flat()
		.filter((a) => a.kind === "node_idle" || a.kind === "run_idle");
}

function describeReason(reason: IdleReason): string {
	switch (reason.type) {
		case "budget_exhausted":
			return `the ${reason.kind} budget is spent (${reason.spent} of ${reason.limit})`;
		case "executor_unavailable":
			return `the executor cannot serve model alias ${reason.alias}: ${reason.error}`;
	}
}

function describeOutcome(outcome: Outcome): string {
	switch (outcome.type) {
		case "done":
			return `done: ${JSON.stringify(outcome.value)}`;
		case "cancelled":
			return "cancelled";
		case "failed":
			return `failed: ${JSON.stringify(outcome.reason)}`;
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
						...item.message.split("\n").map((l) => `  > ${l}`),
						`Reply with: npx wallis send ${item.runId} '${item.node}' "<your reply>"`,
					].join("\n");
				case "run_idle":
					return [
						`Run ${item.runId} is paused: ${describeReason(item.reason)}.`,
						item.reason.type === "budget_exhausted"
							? `Raise it with: npx wallis resume ${item.runId} --budget ${item.reason.kind === "compute_minutes" ? "computeMinutes" : item.reason.kind}=<new limit>`
							: `Fix the executor or rebind the alias, then: npx wallis resume ${item.runId} --model ${item.reason.alias}=<provider/model:thinking>`,
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
	return to;
}
