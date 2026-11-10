// Reading runs without driving them: status from a refold of the log, the
// derived `stopped`, what needs attention, and agent-readable summaries.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, Json } from "../sdk/index.ts";
import { blobPath, nodeDirName, readBlob, refsIn, shareBlobs } from "./artifacts.ts";
import { Core, type Event, type FailReason, type IdleCause, type IdleReason, type Outcome, type Refusal, type Snapshot } from "./core.ts";
import { EventLog } from "./log.ts";
import { mayControl, type Owner, ownerAlive } from "./owner.ts";
import { RunRefused } from "./session.ts";
import { acquireLock, listRuns, lockHolder, readMeta, type RunPaths, runPaths } from "./store.ts";

export interface RunView {
	readonly runId: string;
	readonly dir: string;
	/** Answer schemas of the workflow's orchestrator nodes, from run metadata. */
	readonly answers: Readonly<Record<string, Json>>;
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
		dir: paths.dir,
		answers: meta?.answers ?? {},
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

/**
 * A verb the orchestrator may use on an item: its arguments as a JSON
 * Schema, and the CLI form. MCP tools take the same arguments plus
 * `run_id` (and `node_id` for node verbs).
 */
export type Action = { readonly verb: "send" | "submit_result" | "restart" | "cancel" | "resume"; readonly args: Json; readonly cli: string };

/** How an orchestrator views an artifact in an orchestrator node's input. */
export type ArtifactView = { readonly ref: ArtifactRef; readonly path: string; readonly export: string };

/** What needs the orchestrator, in a stable order; every item lists the verbs that resolve it. */
export type Attention =
	/** An agent's question to its caller, through its `ask` tool. */
	| { readonly kind: "agent_ask"; readonly runId: string; readonly node: string; readonly agent: string; readonly question: string; readonly steerable: boolean; readonly actions: readonly Action[] }
	/** An agent ended its turn with neither a result nor a question: its final text. */
	| { readonly kind: "ended_without_result"; readonly runId: string; readonly node: string; readonly agent: string; readonly text: string; readonly steerable: boolean; readonly actions: readonly Action[] }
	| { readonly kind: "turn_limit"; readonly runId: string; readonly node: string; readonly agent: string; readonly used: number; readonly limit: number; readonly steerable: boolean; readonly actions: readonly Action[] }
	| { readonly kind: "interrupted"; readonly runId: string; readonly node: string; readonly agent: string; readonly steerable: boolean; readonly actions: readonly Action[] }
	/** A tool call in flight at a crash, not safe to make again (in an agent call, or the body's): did it take effect? Restart retries it. */
	| { readonly kind: "outcome_unknown"; readonly runId: string; readonly node: string; readonly tool: string; readonly args: Json; readonly actions: readonly Action[] }
	/** An orchestrator node: submit a result that matches its answer schema. */
	| { readonly kind: "orchestrator_pending"; readonly runId: string; readonly node: string; readonly name: string; readonly input: Json; readonly artifacts: readonly ArtifactView[]; readonly actions: readonly Action[] }
	| { readonly kind: "run_idle"; readonly runId: string; readonly reason: IdleReason; readonly actions: readonly Action[] }
	| { readonly kind: "finished"; readonly runId: string; readonly outcome: Outcome; readonly actions: readonly Action[] }
	| { readonly kind: "stopped"; readonly runId: string; readonly actions: readonly Action[] }
	/** A node failure the body did not handle: the run waits on it, other branches go on. */
	| { readonly kind: "node_failed"; readonly runId: string; readonly node: string; readonly reason: FailReason; readonly actions: readonly Action[] };

/** The kinds that mean a node waits for its owner. */
const NODE_KINDS: ReadonlySet<Attention["kind"]> = new Set(["agent_ask", "ended_without_result", "turn_limit", "interrupted", "outcome_unknown", "orchestrator_pending"]);

const TEXT = { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false } as const;
const q = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

function nodeActions(runId: string, node: string, steerable: boolean): Action[] {
	const restart: Action = steerable
		? { verb: "restart", args: { type: "object", properties: { note: { type: "string" }, turns: { type: "integer", minimum: 1 } }, additionalProperties: false }, cli: `npx wallis restart ${runId} ${q(node)} [note] [--turns n]` }
		: { verb: "restart", args: { type: "object", properties: { turns: { type: "integer", minimum: 1 } }, additionalProperties: false }, cli: `npx wallis restart ${runId} ${q(node)} [--turns n]` };
	return [restart, { verb: "cancel", args: { type: "object", properties: {}, additionalProperties: false }, cli: `npx wallis cancel ${runId} --node ${q(node)}` }];
}

/** Every artifact ref in a value, with where the orchestrator can read it. */
function artifactViews(runId: string, dir: string, value: Json): ArtifactView[] {
	return refsIn(value).map((ref) => ({ ref, path: blobPath(dir, ref.digest), export: `npx wallis export ${runId} ${ref.digest} <dir>` }));
}

/** What a human or harness should look at in this run, in a stable order. */
export function attention(view: RunView): Attention[] {
	const items: Attention[] = [];
	const status = view.run.status;
	const runId = view.runId;
	if (status?.type === "finished") return [{ kind: "finished", runId, outcome: status.outcome, actions: [] }];
	for (const node of view.run.nodes) {
		if (node.type === "orchestrator_pending") {
			const schema = view.answers[node.name] ?? {};
			items.push({
				kind: "orchestrator_pending",
				runId,
				node: node.id,
				name: node.name,
				input: node.input,
				artifacts: artifactViews(runId, view.dir, node.input),
				actions: [
					{ verb: "submit_result", args: { type: "object", required: ["value"], properties: { value: schema }, additionalProperties: false }, cli: `npx wallis submit ${runId} ${q(node.id)} '<json>'` },
					...nodeActions(runId, node.id, false),
				],
			});
			continue;
		}
		if (node.type === "tool_outcome_unknown") {
			items.push({ kind: "outcome_unknown", runId, node: node.id, tool: node.tool, args: node.input, actions: nodeActions(runId, node.id, false) });
			continue;
		}
		if (node.type !== "node_idle") continue;
		const base = { runId, node: node.id, agent: node.agent };
		const send: Action = { verb: "send", args: TEXT as unknown as Json, cli: `npx wallis send ${runId} ${q(node.id)} "<message>"` };
		const others = nodeActions(runId, node.id, node.steerable);
		switch (node.cause.type) {
			case "question":
				items.push({ kind: "agent_ask", ...base, question: node.cause.message, steerable: node.steerable, actions: node.steerable ? [send, ...others] : others });
				break;
			case "ended_without_result":
				items.push({ kind: "ended_without_result", ...base, text: node.cause.text, steerable: node.steerable, actions: node.steerable ? [send, ...others] : others });
				break;
			case "turn_limit":
				items.push({
					kind: "turn_limit",
					...base,
					used: node.cause.used,
					limit: node.cause.limit,
					steerable: node.steerable,
					actions: [
						...(node.steerable
							? [{ verb: "send" as const, args: { type: "object", required: ["turns"], properties: { turns: { type: "integer", minimum: 1 }, text: { type: "string" } }, additionalProperties: false }, cli: `npx wallis send ${runId} ${q(node.id)} --turns <n> ["<message>"]` }]
							: []),
						...others,
					],
				});
				break;
			case "interrupted":
				items.push({ kind: "interrupted", ...base, steerable: node.steerable, actions: node.steerable ? [send, ...others] : others });
				break;
			case "outcome_unknown":
				items.push({ kind: "outcome_unknown", runId, node: node.id, tool: node.cause.tool, args: node.cause.args, actions: others });
				break;
		}
	}
	const resume = (args: Json, cli: string): Action => ({ verb: "resume", args, cli });
	if (status?.type === "idle" && status.reason?.type === "node_failure") {
		items.push({ kind: "node_failed", runId, node: status.reason.node, reason: status.reason.reason, actions: nodeActions(runId, status.reason.node, true) });
	} else if (status?.type === "idle" && status.reason) {
		const reason = status.reason;
		const actions =
			reason.type === "budget_reached"
				? [resume({ type: "object", required: ["budget"], properties: { budget: { type: "object", properties: { [reason.kind === "compute_minutes" ? "computeMinutes" : reason.kind]: { type: "number", exclusiveMinimum: reason.spent } } } } }, `npx wallis resume ${runId} --budget ${reason.kind === "compute_minutes" ? "computeMinutes" : reason.kind}=<new limit>`)]
				: reason.type === "executor_unavailable"
					? [resume({ type: "object", properties: { models: { type: "object", properties: { [reason.alias]: { type: "string" } } } } }, `npx wallis resume ${runId} [--model ${reason.alias}=<provider/model:thinking>]`)]
					: [resume({ type: "object", properties: {} }, `npx wallis resume ${runId}`)];
		items.push({ kind: "run_idle", runId, reason, actions });
	} else if (view.run.held !== null && view.run.held !== undefined) {
		const held = view.run.held;
		const node = view.run.nodes.find((n) => n.id === held);
		const reason: FailReason =
			node?.type === "node_done" && node.outcome.type === "node_failed"
				? { type: "agent_gave_up", agent: node.agent, failure: node.outcome.failure }
				: node?.type === "command_done" && node.outcome.type === "failed_with"
					? { type: "command_crashed", command: node.command, failure: node.outcome.failure }
					: node?.type === "tool_done" && node.outcome.type === "tool_failed_with"
						? { type: "tool_crashed", tool: node.tool, failure: node.outcome.failure }
						: { type: "body_error", message: "failed" };
		items.push({ kind: "node_failed", runId, node: held, reason, actions: nodeActions(runId, held, true) });
	}
	if (view.stopped && status?.type === "running") items.push({ kind: "stopped", runId, actions: [resume({ type: "object", properties: {} }, `npx wallis resume ${runId}`)] });
	return items;
}

export function attentionKey(item: Attention): string {
	switch (item.kind) {
		case "agent_ask":
			return `${item.runId} node ${item.node} ask ${item.question}`;
		case "turn_limit":
			return `${item.runId} node ${item.node} limit ${item.used}/${item.limit}`;
		case "ended_without_result":
		case "interrupted":
		case "outcome_unknown":
		case "orchestrator_pending":
			return `${item.runId} node ${item.node} ${item.kind}`;
		case "node_failed":
			return `${item.runId} failed ${item.node}`;
		case "run_idle":
			return `${item.runId} idle ${JSON.stringify(item.reason)}`;
		default:
			return `${item.runId} ${item.kind}`;
	}
}

/** Nodes and runs waiting for the orchestrator under `root`, of runs the caller controls (all of them when no caller is given). */
export function pending(root: string, caller?: Owner): Attention[] {
	return listRuns(root)
		.map((p) => inspectRun(p.dir))
		.filter((v) => caller === undefined || mayControl(caller, v.owner))
		.map((v) => attention(v))
		.flat()
		.filter((a) => NODE_KINDS.has(a.kind) || a.kind === "run_idle");
}

/** Unfinished runs whose owner is gone (or never set): anyone may claim them. */
export function claimable(root: string): RunView[] {
	return listRuns(root)
		.map((p) => inspectRun(p.dir))
		.filter((v) => v.run.status?.type !== "finished" && !v.ownerAlive);
}

function describeReason(reason: IdleReason): string {
	switch (reason.type) {
		case "budget_reached":
			return `the ${reason.kind} budget is reached (${reason.spent} of ${reason.limit}; calls in flight finished)`;
		case "executor_unavailable":
			return `the executor cannot serve model alias ${reason.alias}: ${reason.error}`;
		case "paused_by_user":
			return "its owner paused it";
		case "node_failure":
			return `node ${reason.node} failed and the workflow did not handle it`;
	}
}

/** The message sent with granted turns when the caller gives none. */
export const CONTINUE = "Continue.";

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

const quoted = (text: string) =>
	truncate(text, MESSAGE_CAP)
		.split("\n")
		.map((l) => `  > ${l}`);

/** One paragraph per item, with the commands that answer it: the text for humans (`--json` gives the items). */
export function describe(items: readonly Attention[]): string {
	return items
		.map((item) => {
			const how = [...("steerable" in item && !item.steerable ? ["  Its agent is not steerable: it takes no messages; restart or cancel it."] : []), ...item.actions.map((a) => `  ${a.verb}: ${a.cli}`)];
			switch (item.kind) {
				case "agent_ask":
					return [`Run ${item.runId}: node ${item.node} (${item.agent}) asks:`, ...quoted(item.question), ...how].join("\n");
				case "ended_without_result":
					return [`Run ${item.runId}: node ${item.node} (${item.agent}) ended its turn without a result. Its last words:`, ...quoted(item.text), ...how].join("\n");
				case "turn_limit":
					return [`Run ${item.runId}: node ${item.node} (${item.agent}) used ${item.used} of ${item.limit} turns without submitting; its progress is kept.`, ...how].join("\n");
				case "interrupted":
					return [`Run ${item.runId}: node ${item.node} (${item.agent}) was interrupted; its progress is kept. Send it a message to continue.`, ...how].join("\n");
				case "outcome_unknown":
					return [
						`Run ${item.runId}: node ${item.node} was calling ${item.tool} when the host stopped, and that call is not safe to make again. Whether it took effect is unknown. Its arguments:`,
						...quoted(JSON.stringify(item.args, null, 2)),
						"Check the outside world; restart to retry the call, or cancel.",
						...how,
					].join("\n");
				case "orchestrator_pending":
					return [
						`Run ${item.runId}: orchestrator node ${item.node} (${item.name}) waits for your result. Its input:`,
						...quoted(JSON.stringify(item.input, null, 2)),
						...item.artifacts.map((a) => `  artifact ${a.ref.name} (${a.ref.media}): ${a.path}`),
						`Answer schema: ${JSON.stringify((item.actions[0]!.args as { properties: { value: Json } }).properties.value)}`,
						...how,
					].join("\n");
				case "run_idle":
					return [`Run ${item.runId} is paused: ${describeReason(item.reason)}.`, ...how].join("\n");
				case "node_failed":
					return [
						`Run ${item.runId}: node ${item.node} failed and the workflow did not handle it: ${truncate(JSON.stringify(item.reason), RESULT_CAP)}`,
						"Other branches go on. Restart it (completed work is kept; the tools it uses reach the outside again), or cancel it to accept the failure.",
						...how,
					].join("\n");
				case "finished":
					return `Run ${item.runId} finished, ${describeOutcome(item.outcome)}.`;
				case "stopped":
					return [`Run ${item.runId} stopped: no process drives it.`, ...how].join("\n");
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
	const baseline = new Set(attention(inspectRun(dir)).filter((a) => NODE_KINDS.has(a.kind)).map(attentionKey));
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
 * Copies a run into a new one: its whole journal (a cache), blobs and
 * layers (everything the log names), so the fork re-executes the body and
 * every unchanged call hits. The source's live work dirs (calls in flight
 * or waiting, tool connections) are not copied: they are the source's. Only the
 * events that ended the source are left out. The cache is per run and its
 * forks; it is never shared implicitly with other runs.
 */
/**
 * A new run with the source's whole journal (a cache), which re-executes.
 * `forget` names calls (request ids) the fork forgets: each gets a
 * `call_forgotten` mark, so it executes again and calls downstream of it
 * miss when their inputs change. Each forget is checked by the core first
 * (`by` must own the run); a refused one leaves no fork behind.
 */
export function forkRun(source: string, target: string, options: { readonly forget?: readonly string[]; readonly by?: string } = {}): RunPaths {
	const from = runPaths(source);
	const to = runPaths(target);
	if (existsSync(to.log)) throw new Error(`run ${to.id} already exists`);
	// A fork snapshots its binds anew (the `binds` fact is not copied): edits since the source started reach it.
	const events = new EventLog(from.log)
		.read()
		// Nor this run's hits: they are what its hosts reused, not the fork's.
		.filter((e: Event) => e.type !== "body_finished" && e.type !== "body_failed" && e.type !== "cancel_requested" && !(e.type === "noted" && (e.key === "binds" || e.key === "hits" || e.key.startsWith("hit "))));
	if ((options.forget ?? []).length > 0) {
		const core = Core.refold(events);
		const by = options.by ?? core.snapshot().owner ?? "human";
		for (const node of options.forget ?? []) {
			const event: Event = { type: "call_forgotten", node, by };
			const refused = core.step(event).find((e) => e.type === "refuse");
			if (refused && refused.type === "refuse") throw new RunRefused(refused.refusal);
			events.push(event);
		}
	}
	mkdirSync(to.dir, { recursive: true });
	// Blobs and layers first: the log names them. Both are immutable, so hardlinks share them.
	shareBlobs(from.dir, to.dir);
	if (existsSync(join(from.dir, "layers"))) spawnSync("cp", ["-al", join(from.dir, "layers"), join(to.dir, "layers")]);
	// Commands' files, which their journaled results name.
	if (existsSync(join(from.dir, "outputs"))) spawnSync("cp", ["-al", join(from.dir, "outputs"), join(to.dir, "outputs")]);
	// Where the fork comes from is a fact of its own log; meta.json is derived from it.
	const at = events.filter((e) => e.type !== "call_forgotten").length;
	events.push({ type: "noted", key: "created", value: new Date().toISOString() }, { type: "noted", key: "forked_from", value: { run_id: from.id, at } });
	writeFileSync(to.log, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
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
 * Applies a control event (a claim, pause or node cancel) to a run no process drives: takes the
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
	const baseline = new Set(own().flatMap((v) => attention(v).filter((a) => NODE_KINDS.has(a.kind)).map(attentionKey)));
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

/** The latest observed value per label, for `wallis status`. */
export function latestObservations(v: RunView): Record<string, Json> {
	return Object.fromEntries(v.run.observations.map((o) => [o.label, o.value]));
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
/** The run as a tree. `full`: each loop iteration's whole state, else its first 120 characters. */
export function renderTree(v: RunView, options: { readonly full?: boolean } = {}): string {
	const lines = [runLine(v)];
	const depthOf = (id: string) => (id.match(/[.>]/g) ?? []).length;
	for (const node of v.run.nodes) {
		const indent = "  ".repeat(depthOf(node.id) + 1);
		const inbox = "inbox" in node && node.inbox.length > 0 ? `  inbox: ${node.inbox.map((m) => `${m.kind}@${m.step}`).join(",")}` : "";
		switch (node.type) {
			case "command_running":
			case "command_held":
			case "command_done":
				lines.push(`${indent}${node.id}  ${node.command}  command  ${node.type === "command_done" ? `done (${node.outcome.type})` : node.type === "command_held" ? `held (${node.reason.type})` : "running"}${inbox}`);
				break;
			case "tool_running":
			case "tool_held":
			case "tool_outcome_unknown":
			case "tool_done":
				lines.push(`${indent}${node.id}  ${node.tool}  tool  ${node.type === "tool_done" ? `done (${node.outcome.type})` : node.type === "tool_running" ? "running" : node.type === "tool_held" ? `held (${node.reason.type})` : "outcome unknown"}`);
				break;
			case "orchestrator_pending":
			case "orchestrator_done":
			case "orchestrator_dropped":
				lines.push(`${indent}${node.id}  ${node.name}  orchestrator  ${node.type === "orchestrator_done" ? "done" : node.type === "orchestrator_dropped" ? "cancelled" : "pending"}`);
				break;
			case "node_refused":
				lines.push(`${indent}${node.id}  refused (${node.refusal.type})`);
				break;
			case "node_running":
			case "node_idle":
			case "node_held":
			case "node_done": {
				const cause = node.type === "node_idle" ? node.cause : null;
				const status =
					node.type === "node_held"
						? `held (${node.reason.type})`
						: cause === null
							? node.type === "node_done"
								? `done (${node.outcome.type})`
								: "running"
							: cause.type === "question"
								? `idle (question): ${truncate(cause.message, 80)}`
								: cause.type === "ended_without_result"
									? `idle (ended without result): ${truncate(cause.text, 80)}`
									: cause.type === "turn_limit"
										? `idle: turn limit ${cause.used}/${cause.limit}`
										: cause.type === "outcome_unknown"
											? `idle: outcome of ${cause.tool} unknown`
											: "idle: interrupted";
				lines.push(`${indent}${node.id}  ${node.agent}  ${node.model}  ${status}${node.steerable ? "" : "  (not steerable)"}${inbox}`);
			}
		}
	}
	// Loops (`ctx.loop`): the loop, then each iteration with its state; the rest are plain observations.
	const loops = new Map<string, { at: string; iteration: number; state: Json; full: string | null }[]>();
	const finished = new Map<string, number>();
	for (const o of v.run.observations) {
		if (!o.label.startsWith("loop ")) {
			lines.push(`${"  ".repeat(depthOf(o.at) + 1)}${o.at}  observe ${o.label} = ${truncate(JSON.stringify(o.value), 120)}`);
			continue;
		}
		const at = o.label.slice("loop ".length);
		const value = o.value as { iteration?: number; state?: Json; done?: boolean; full?: string };
		if (value.done) finished.set(at, (value.iteration ?? 0) + 1);
		else loops.set(at, [...(loops.get(at) ?? []), { at: o.at, iteration: value.iteration ?? 0, state: value.state ?? null, full: value.full ?? null }]);
	}
	for (const [at, iterations] of loops) {
		const total = finished.get(at);
		lines.push(`${"  ".repeat(depthOf(at) + 1)}${at}  loop  ${total === undefined ? `iteration ${iterations.length - 1} (current)` : `done after ${total} iteration${total === 1 ? "" : "s"}`}`);
		for (const it of iterations) {
			const indent = "  ".repeat(depthOf(it.at) + 1);
			if (!options.full) {
				lines.push(`${indent}${it.at}  iteration ${it.iteration}  state = ${truncate(JSON.stringify(it.state), 120)}`);
				continue;
			}
			// The whole state: from the run's store when the log keeps it truncated.
			const whole = it.full === null ? it.state : (JSON.parse(readBlob(v.dir, it.full) ?? JSON.stringify({ missing: it.full })) as Json);
			lines.push(`${indent}${it.at}  iteration ${it.iteration}  state =`, ...JSON.stringify(whole, null, 2).split("\n").map((l) => `${indent}    ${l}`));
		}
	}
	// Session values, as a tree of branches: each is the session after a call of its parent.
	const sessions = v.run.sessions ?? [];
	if (sessions.length > 0) {
		lines.push("  sessions");
		const branch = (from: string | null, depth: number): void => {
			for (const s of sessions.filter((x) => x.from === from)) {
				lines.push(`${"  ".repeat(depth + 2)}${s.id.slice(0, 9)}  ${s.agent}  after ${s.call}${from === null ? " (new session)" : ""}`);
				branch(s.id, depth + 1);
			}
		};
		branch(null, 0);
	}
	return lines.join("\n");
}

/**
 * How a `send` was delivered, read from the log: as the reply to the
 * node's question (quoted), or queued as a steer after its current turn.
 */
export function deliveryOf(dir: string, messageId: string): string | null {
	const events = new EventLog(runPaths(dir).log).read();
	const at = events.findIndex((e) => (e.type === "sent" || e.type === "steered") && e.message_id === messageId);
	if (at < 0) return null;
	const event = events[at]!;
	if (event.type === "steered") return `queued as steer after the current turn of ${event.node}`;
	if (event.type !== "sent") return null;
	for (let i = at - 1; i >= 0; i--) {
		const e = events[i]!;
		if (!("id" in e) || e.id !== event.node) continue;
		if (e.type === "agent_asked" || e.type === "agent_idle") return `delivered to ${event.node} as the reply to: ${truncate(e.message, 300)}`;
		if (e.type === "turn_limit_reached") return `delivered to ${event.node} with ${event.turns} more turns (it was at its turn limit)`;
		if (e.type === "turn_interrupted") return `delivered to ${event.node} after its interrupt`;
	}
	return `delivered to ${event.node}`;
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
