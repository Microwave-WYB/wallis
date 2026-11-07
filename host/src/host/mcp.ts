// A minimal stdio MCP server: every workflow under `.agents/workflows/` is
// runnable by name. Runs are driven in this process. Every tool result ends
// with what is pending in the project, so a harness sees questions without
// polling; for notification, the caller runs `npx wallis wait <run_id>` in
// the background.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Json } from "../sdk/index.ts";
import { toJson } from "../sdk/validate.ts";
import { BadId, type NodeId, parseNodeId, parseRunId, type RunId } from "./capability.ts";
import { mayControl, NotOwner } from "./owner.ts";
import { declarationsOf } from "./sandbox.ts";
import { attention, claimable, describe, listRunViews, nodeTranscript, pending, renderTree, runLine, runLog, type RunView, waitForAttention } from "./query.ts";
import { type Runs, SendRefused } from "./runs.ts";
import { RunRefused } from "./session.ts";
import { runPaths, runsDir } from "./store.ts";
import { workflowsIn } from "./runs.ts";
import { join } from "node:path";

/** Server-side cap on one `wait` call. */
export const WAIT_CAP_SECONDS = 30;

const INSTRUCTIONS = `wallis runs declarative agent workflows committed under .agents/workflows/.
- Start one with the "run" tool. It returns a run id at once; the run continues in the background.
- To be notified, run \`npx wallis wait <run_id>\` as a background shell command. It exits with an agent-readable summary when something needs attention: a node asks a question, the run pauses (budget, executor) or finishes.
- A node that asks a question waits for a reply: answer it with "send" (run_id, node_id, text).
- A running node of a steerable agent can be steered ("steer", delivered at its next step) or interrupted ("interrupt"); "restart" discards a node's progress and reissues its call with an operator note.
- "get_run" shows status, nodes and observations; "wait" long-polls (capped at ${WAIT_CAP_SECONDS}s); "cancel" ends a run.
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
		if (error instanceof RunRefused || error instanceof SendRefused) return reply(`Refused: ${JSON.stringify(error.refusal)}`, { refusal: error.refusal }, true);
		if (error instanceof NotOwner) return reply(`Not yours: ${error.message}`, { error: "not_owner" }, true);
		if (error instanceof BadId) return reply(`Bad id: ${error.message}`, { error: "bad_id" }, true);
		return reply(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
	};
	const data = (view: RunView): Json =>
		JSON.parse(
			JSON.stringify({
				run_id: view.runId,
				workflow: view.workflow,
				status: view.run.status,
				stopped: view.stopped,
				nodes: view.run.nodes,
				observations: view.run.observations,
				spent: view.run.spent,
			}),
		);
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
				mounts: z.record(z.string(), z.string()).optional().describe("Mount remaps, name -> host dir (read-only)"),
			},
		},
		async ({ workflow, input, seed, models, mounts }) => {
			try {
				const parsed = toJson(input ?? null);
				if (!parsed.ok) return reply(`Bad input: ${parsed.errors.join("; ")}`, { error: "bad_input" }, true);
				const session = await runs.start({ workflow, input: parsed.value, seed, models, mounts });
				const view = runs.view(parseRunId(session.paths.id));
				return reply(
					`${summary(view)}\n\nTo be notified when it needs attention, run in the background: npx wallis wait ${view.runId}`,
					data(view),
				);
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"send",
		{
			description: "Answer a node that is waiting for a reply (an agent that ended its turn with a question). Non-steerable agents take no answers.",
			inputSchema: { run_id: z.string(), node_id: z.string(), text: z.string() },
		},
		async ({ run_id, node_id, text }) => {
			try {
				const { run, node } = ids(run_id, node_id);
				await runs.answer(run, node, text);
				const view = runs.view(run);
				return reply(summary(view), data(view));
			} catch (error) {
				return failure(error);
			}
		},
	);

	// Steering reaches only steerable agents; the schemas enumerate them.
	if (steerable.length > 0) {
		const agent = z.enum(steerable as [string, ...string[]]).describe("The node's agent; only steerable agents are listed");
		const matches = (run: RunId, node: NodeId, name: string) => {
			const found = runs.view(run).run.nodes.find((n) => n.id === node);
			if (found && found.agent !== name) throw new Error(`node ${node} runs agent ${found.agent}, not ${name}`);
		};
		server.registerTool(
			"steer",
			{
				description: "Send a message to a running node of a steerable agent; it arrives at the node's next step boundary, with progress kept.",
				inputSchema: { run_id: z.string(), node_id: z.string(), agent, text: z.string() },
			},
			async ({ run_id, node_id, agent: name, text }) => {
				try {
					const { run, node } = ids(run_id, node_id);
					matches(run, node, name);
					runs.steer(run, node, text);
					return reply(summary(runs.view(run)));
				} catch (error) {
					return failure(error);
				}
			},
		);
		server.registerTool(
			"interrupt",
			{
				description: "Abort a running node's current step (steerable agents only), then deliver text, if given, to it. Progress is kept.",
				inputSchema: { run_id: z.string(), node_id: z.string(), agent, text: z.string().optional() },
			},
			async ({ run_id, node_id, agent: name, text }) => {
				try {
					const { run, node } = ids(run_id, node_id);
					matches(run, node, name);
					runs.interrupt(run, node, text);
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
			description: "Discard a node's progress and reissue its call with the original input plus an operator note (no note for non-steerable agents). Logged.",
			inputSchema: { run_id: z.string(), node_id: z.string(), note: z.string().optional() },
		},
		async ({ run_id, node_id, note }) => {
			try {
				const { run, node } = ids(run_id, node_id);
				await runs.restart(run, node, note);
				return reply(summary(runs.view(run)));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"get_run",
		{ description: "Status, nodes and spend of a run.", inputSchema: { run_id: z.string() } },
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
		"cancel",
		{
			description: "Cancel a run (completed work stays in its log), or with node_id fail just that node as an agent failure for the workflow to handle.",
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
		reply(`${text}\n${page.items.length} of ${page.total}; next cursor: ${page.next}${page.next < page.total ? " (more)" : ""}`, JSON.parse(JSON.stringify(page)));

	server.registerTool(
		"list_runs",
		{ description: "Every run in this project: status, owner, stopped.", inputSchema: {} },
		async () => {
			const views = listRunViews(runs.root);
			return reply(views.map(runLine).join("\n") || "No runs.", views.map((v) => ({ run_id: v.runId, workflow: v.workflow, status: v.run.status, stopped: v.stopped, owner: v.owner })) as never);
		},
	);

	server.registerTool(
		"run_tree",
		{ description: "A run's nodes as a tree (branches and sub-workflows), with agent, model and status.", inputSchema: { run_id: z.string() } },
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
		{ description: "Resume a paused or stopped run.", inputSchema: { run_id: z.string() } },
		async ({ run_id }) => {
			try {
				const run = parseRunId(run_id);
				await runs.unpause(run);
				return reply(summary(runs.view(run)));
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
				return reply(items ? describe(items) : `Run ${run} is still running.`, data(view));
			} catch (error) {
				return failure(error);
			}
		},
	);

	return server;
}
