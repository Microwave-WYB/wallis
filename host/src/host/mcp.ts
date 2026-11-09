// A minimal stdio MCP server: every workflow under `.agents/workflows/` is
// runnable by name. Runs are driven in this process. Every tool result ends
// with what is pending in the project, so a harness sees questions without
// polling; for notification, the caller runs `npx wallis wait <run_id>` in
// the background. Pending items are also returned as JSON, each with the
// actions that resolve it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Json } from "../sdk/index.ts";
import { toJson } from "../sdk/validate.ts";
import { BadId, type NodeId, parseNodeId, parseRunId, type RunId } from "./capability.ts";
import { describeWorkflow } from "./describe.ts";
import { mayControl, NotOwner } from "./owner.ts";
import { declarationsOf } from "./sandbox.ts";
import { attention, CONTINUE, claimable, describe, listRunViews, nodeTranscript, pending, renderTree, runLine, runLog, type RunView, waitForAttention } from "./query.ts";
import { resolveWorkflow, type Runs, SendRefused, workflowsIn } from "./runs.ts";
import { RunRefused } from "./session.ts";
import { runPaths, runsDir } from "./store.ts";
import { join } from "node:path";

/** Server-side cap on one `wait` call. */
export const WAIT_CAP_SECONDS = 30;

const INSTRUCTIONS = `wallis runs declarative agent workflows committed under .agents/workflows/. You are their orchestrator.
- "describe" shows a workflow's input, its agents and the questions it may ask you (orchestrator nodes, with their answer schemas). Start a run with "run"; it continues in the background.
- To be notified, run \`npx wallis wait <run_id>\` as a background shell command. It exits with a summary when something needs you: an agent asks or ends its turn without a result, an orchestrator node waits, a tool call's outcome is unknown after a crash, the run pauses (budget, executor) or finishes.
- Every pending item ("pending", "wait" and "get_run" return them as JSON) has a kind and its actions: the verbs that resolve it, with their argument schemas.
- "send" gives an agent node a message: the reply to its question if it is idle, or a steer after its current turn if it is running; the result says which. "submit_result" completes an orchestrator node. "interrupt" stops a running node's turn; then "send" redirects it.
- "restart" discards a node's progress and reissues its call. The tools it uses reach the outside again: that is not reproduction.
- Questions reach you without context: answer from the item alone. Forks of a run share you as their orchestrator, so an answer can leak between ablations.
Every tool result ends with the items pending in this project.`;

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };

function summary(view: RunView): string {
	const items = attention(view);
	const status = view.run.status?.type ?? "unknown";
	const head = `Run ${view.runId}${view.workflow ? ` (${view.workflow})` : ""}: ${status}${view.stopped ? ", stopped" : ""}.`;
	return items.length > 0 ? `${head}\n\n${describe(items)}` : head;
}

/** Agent names that may be steered, across the project's workflows. */
async function steerableAgents(root: string): Promise<string[]> {
	const names = new Set<string>();
	for (const path of Object.values(workflowsIn(root))) {
		for (const [name, agent] of Object.entries((await declarationsOf(path)).agents)) if (agent.steerable) names.add(name);
	}
	return [...names].sort();
}

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

export async function createMcpServer(runs: Runs): Promise<McpServer> {
	const workflows = Object.keys(workflowsIn(runs.root));
	const steerable = await steerableAgents(runs.root);
	const server = new McpServer({ name: "wallis", version: "0.0.0" }, { instructions: INSTRUCTIONS });

	const reply = (text: string, data?: Json, isError = false): Text => {
		const items = pending(runs.root, runs.owner);
		const orphans = claimable(runs.root).filter((v) => !mayControl(runs.owner, v.owner));
		let tail = items.length > 0 ? `\n\nPending in this project:\n${describe(items)}` : "\n\nNothing else is pending in this project.";
		if (orphans.length > 0) tail += `\n${orphans.length} run(s) have no live owner and can be claimed: ${orphans.map((v) => v.runId).join(", ")}`;
		const content: Text["content"] = [{ type: "text", text: `${text}${tail}` }];
		if (data !== undefined) content.push({ type: "text", text: JSON.stringify(data) });
		return isError ? { content, isError } : { content };
	};
	const failure = (error: unknown): Text => {
		if (error instanceof RunRefused || error instanceof SendRefused) return reply(`Refused: ${JSON.stringify(error.refusal)}`, json({ refusal: error.refusal }), true);
		if (error instanceof NotOwner) return reply(`Not yours: ${error.message}`, { error: "not_owner" }, true);
		if (error instanceof BadId) return reply(`Bad id: ${error.message}`, { error: "bad_id" }, true);
		return reply(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
	};
	const data = (view: RunView): Json =>
		json({
			run_id: view.runId,
			workflow: view.workflow,
			status: view.run.status,
			stopped: view.stopped,
			nodes: view.run.nodes,
			observations: view.run.observations,
			spent: view.run.spent,
			attention: attention(view),
		});
	/** Ids from the caller are parsed before anything uses them. */
	const ids = (run_id: unknown, node_id?: unknown): { run: RunId; node: NodeId } => ({ run: parseRunId(run_id), node: parseNodeId(node_id ?? "#0") });

	server.registerTool(
		"run",
		{
			description: `Start a workflow run. Workflows: ${workflows.join(", ") || "(none)"}. Returns the run id; then run \`npx wallis wait <run_id>\` in the background to be notified.`,
			inputSchema: {
				workflow: z.string().describe(`Workflow name: ${workflows.join(", ")}`),
				input: z.any().optional().describe("Workflow input (JSON)"),
				seed: z.number().int().optional(),
				models: z.record(z.string(), z.string()).optional().describe("Model alias remaps, alias -> provider/model:thinking"),
				volumes: z.record(z.string(), z.string()).optional().describe("Host dirs for bind volumes, container target -> host dir (read-only)"),
				bins: z.record(z.string(), z.string()).optional().describe("Paths of required binaries, name -> absolute path"),
			},
		},
		async ({ workflow, input, seed, models, volumes, bins }) => {
			try {
				const parsed = toJson(input ?? null);
				if (!parsed.ok) return reply(`Bad input: ${parsed.errors.join("; ")}`, { error: "bad_input" }, true);
				const session = await runs.start({ workflow, input: parsed.value, seed, models, volumes, bins });
				const view = runs.view(parseRunId(session.paths.id));
				return reply(`${summary(view)}\n\nTo be notified when it needs attention, run in the background: npx wallis wait ${view.runId}`, data(view));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"describe",
		{
			description: "A workflow's input and output schemas, its agents (model alias, MCP tools by mode), its MCP tool nodes, and the questions it may ask you: its orchestrator nodes with their answer schemas.",
			inputSchema: { workflow: z.string() },
		},
		async ({ workflow }) => {
			try {
				return reply(`Workflow ${workflow}.`, json(await describeWorkflow(resolveWorkflow(runs.root, workflow), runs.root)));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"send",
		{
			description:
				"A message to an agent node. Idle (it asked, ended its turn with a question, was interrupted, or is at its turn limit with `turns`): delivered, and it continues. Running: queued as a steer after its current turn (steerable agents only). The result says how it was delivered.",
			inputSchema: { run_id: z.string(), node_id: z.string(), text: z.string().optional(), turns: z.number().int().positive().optional() },
		},
		async ({ run_id, node_id, text, turns }) => {
			try {
				const { run, node } = ids(run_id, node_id);
				const how = await runs.send(run, node, text ?? CONTINUE, turns ?? 0);
				const view = runs.view(run);
				return reply(`Sent: ${how}.\n\n${summary(view)}`, json({ delivery: how, run: data(view) }));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"submit_result",
		{
			description:
				'Complete an orchestrator node with a value that matches its answer schema. A mismatch returns the errors and the node stays pending.',
			inputSchema: { run_id: z.string(), node_id: z.string(), value: z.any() },
		},
		async ({ run_id, node_id, value }) => {
			try {
				const { run, node } = ids(run_id, node_id);
				await runs.submit(run, node, value);
				const view = runs.view(run);
				return reply(`Submitted to ${node}.\n\n${summary(view)}`, data(view));
			} catch (error) {
				return failure(error);
			}
		},
	);

	// Interrupts reach only steerable agents; the schema enumerates them.
	if (steerable.length > 0) {
		const agent = z.enum(steerable as [string, ...string[]]).describe("The node's agent; only steerable agents are listed");
		server.registerTool(
			"interrupt",
			{
				description: "Abort a running node's current turn, its tool calls included (steerable agents only). It goes idle (interrupted) with its progress kept; then send it a message to redirect it.",
				inputSchema: { run_id: z.string(), node_id: z.string(), agent },
			},
			async ({ run_id, node_id, agent: name }) => {
				try {
					const { run, node } = ids(run_id, node_id);
					const found = runs.view(run).run.nodes.find((n) => n.id === node);
					if (found && (!("agent" in found) || found.agent !== name)) throw new Error(`node ${node} is not a call of agent ${name}`);
					runs.interrupt(run, node);
					return reply(summary(runs.view(run)));
				} catch (error) {
					return failure(error);
				}
			},
		);
	}

	server.registerTool(
		"restart",
		{
			description:
				"Discard a node's progress and reissue its call with the original input plus an operator note (no note for non-steerable agents, commands or tools); `turns` sets its turn allowance. A session call rewinds its session to before that call. A failed node the run is held on is restarted the same way, and the workflow then continues. Logged. The tools the node uses reach the outside world again: that is not reproduction.",
			inputSchema: { run_id: z.string(), node_id: z.string(), note: z.string().optional(), turns: z.number().int().positive().optional() },
		},
		async ({ run_id, node_id, note, turns }) => {
			try {
				const { run, node } = ids(run_id, node_id);
				await runs.restart(run, node, note, turns ?? 0);
				return reply(`Restarted ${node}; the tools it uses reach the outside again.\n\n${summary(runs.view(run))}`);
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"get_run",
		{ description: "Status, nodes, spend and pending items (with their actions) of a run.", inputSchema: { run_id: z.string() } },
		async ({ run_id }) => {
			try {
				const view = runs.view(parseRunId(run_id));
				return reply(summary(view), data(view));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"pending",
		{ description: "Every item waiting for you in this project, as JSON: kind, run, node, the question or input, and the actions that resolve it.", inputSchema: {} },
		async () => {
			const items = pending(runs.root, runs.owner);
			return reply(items.length > 0 ? `${items.length} item(s) pending.` : "Nothing is pending.", json(items));
		},
	);

	server.registerTool(
		"cancel",
		{
			description: "Cancel a run (completed work stays in its log), or with node_id fail just that node as a typed failure for the workflow to handle.",
			inputSchema: { run_id: z.string(), node_id: z.string().optional() },
		},
		async ({ run_id, node_id }) => {
			try {
				const run = parseRunId(run_id);
				if (node_id) await runs.cancelNode(run, parseNodeId(node_id));
				else await runs.cancel(run);
				const view = runs.view(run);
				return reply(summary(view), data(view));
			} catch (error) {
				return failure(error);
			}
		},
	);

	const paged = (text: string, page: { items: unknown[]; next: number; total: number }) =>
		reply(`${text}\n${page.items.length} of ${page.total}; next cursor: ${page.next}${page.next < page.total ? " (more)" : ""}`, json(page));

	server.registerTool(
		"list_runs",
		{ description: "Every run in this project: status, owner, stopped.", inputSchema: {} },
		async () => {
			const views = listRunViews(runs.root);
			return reply(views.map(runLine).join("\n") || "No runs.", json(views.map((v) => ({ run_id: v.runId, workflow: v.workflow, status: v.run.status, stopped: v.stopped, owner: v.owner }))));
		},
	);

	server.registerTool(
		"run_tree",
		{ description: "A run's nodes as a tree (sessions and their calls, branches and sub-workflows), with agent, model and status.", inputSchema: { run_id: z.string() } },
		async ({ run_id }) => {
			try {
				return reply(renderTree(runs.view(parseRunId(run_id))));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"node_transcript",
		{
			description: "A node's transcript (messages, tool calls, results). Capped; pass the returned cursor as since for more.",
			inputSchema: { run_id: z.string(), node_id: z.string(), since: z.number().int().min(0).optional(), limit: z.number().int().positive().optional() },
		},
		async ({ run_id, node_id, since, limit }) => {
			try {
				const page = nodeTranscript(runPaths(join(runsDir(runs.root), parseRunId(run_id))).dir, parseNodeId(node_id), since, limit);
				return paged(page.items.map((e) => `${e.seq}\t${e.entry}`).join("\n"), page);
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"run_log",
		{
			description: "A run's event log. Capped; pass the returned cursor as since for more.",
			inputSchema: { run_id: z.string(), since: z.number().int().min(0).optional(), limit: z.number().int().positive().optional() },
		},
		async ({ run_id, since, limit }) => {
			try {
				const page = runLog(runPaths(join(runsDir(runs.root), parseRunId(run_id))).dir, since, limit);
				return paged(page.items.map((e) => `${e.seq}\t${e.event}`).join("\n"), page);
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"pause",
		{ description: "Pause a run: no new calls are issued; it goes idle (paused_by_user) once in-flight work ends.", inputSchema: { run_id: z.string() } },
		async ({ run_id }) => {
			try {
				const run = parseRunId(run_id);
				await runs.pause(run);
				return reply(summary(runs.view(run)));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"resume",
		{
			description: "Resume a paused, idle or stopped run; optionally raise a budget (`budget`: turns, computeMinutes) or rebind model aliases (`models`).",
			inputSchema: {
				run_id: z.string(),
				budget: z.object({ turns: z.number().positive().optional(), computeMinutes: z.number().positive().optional() }).optional(),
				models: z.record(z.string(), z.string()).optional(),
			},
		},
		async ({ run_id, budget, models }) => {
			try {
				const run = parseRunId(run_id);
				const raised = { ...(budget?.turns === undefined ? {} : { turns: budget.turns }), ...(budget?.computeMinutes === undefined ? {} : { compute_minutes: budget.computeMinutes }) };
				await runs.resume(run, { unpause: true, budget: raised, ...(models ? { models } : {}) });
				const view = runs.view(run);
				return reply(summary(view), data(view));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"wait",
		{
			description: `Block until the run needs attention, at most timeout_s seconds (capped at ${WAIT_CAP_SECONDS}). Prefer \`npx wallis wait <run_id>\` in the background.`,
			inputSchema: { run_id: z.string(), timeout_s: z.number().positive().optional() },
		},
		async ({ run_id, timeout_s }) => {
			try {
				const run = parseRunId(run_id);
				runs.control(run);
				const dir = runPaths(join(runsDir(runs.root), run)).dir;
				const timeoutMs = Math.min(timeout_s ?? WAIT_CAP_SECONDS, WAIT_CAP_SECONDS) * 1000;
				const items = await waitForAttention(dir, { timeoutMs });
				const view = runs.view(run);
				return reply(items ? describe(items) : `Run ${run} is still running.`, json({ items: items ?? [], run: data(view) }));
			} catch (error) {
				return failure(error);
			}
		},
	);

	return server;
}
