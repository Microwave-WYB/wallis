// A minimal stdio MCP server: every workflow under `.agents/workflows/` is
// runnable by name. Runs are driven in this process. Every tool result ends
// with what is pending in the project, so a harness sees questions without
// polling; for notification, the caller runs `npx wallis wait <run_id>` in
// the background.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Json } from "../sdk/index.ts";
import { mayControl, NotOwner } from "./owner.ts";
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
- "get_run" shows status and nodes; "wait" long-polls (capped at ${WAIT_CAP_SECONDS}s); "cancel" ends a run.
Every tool result ends with the items pending in this project.`;

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };

function summary(view: RunView): string {
	const items = attention(view);
	const status = view.run.status?.type ?? "unknown";
	const head = `Run ${view.runId}${view.workflow ? ` (${view.workflow})` : ""}: ${status}${view.stopped ? ", stopped" : ""}.`;
	return items.length > 0 ? `${head}\n\n${describe(items)}` : head;
}

export function createMcpServer(runs: Runs): McpServer {
	const workflows = Object.keys(workflowsIn(runs.root));
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
		return reply(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
	};
	const data = (view: RunView): Json =>
		JSON.parse(JSON.stringify({ run_id: view.runId, workflow: view.workflow, status: view.run.status, stopped: view.stopped, nodes: view.run.nodes, spent: view.run.spent }));

	server.registerTool(
		"run",
		{
			description: `Start a workflow run. Workflows: ${workflows.join(", ") || "(none)"}. Returns the run id; then run \`npx wallis wait <run_id>\` in the background to be notified.`,
			inputSchema: {
				workflow: z.string().describe(`Workflow name: ${workflows.join(", ")}`),
				input: z.any().optional().describe("Workflow input (JSON)"),
				seed: z.number().int().optional(),
				models: z.record(z.string(), z.string()).optional().describe("Model alias remaps, alias -> provider/model:thinking"),
			},
		},
		async ({ workflow, input, seed, models }) => {
			try {
				const session = await runs.start({ workflow, input: (input ?? null) as Json, seed, models });
				const view = runs.view(session.paths.id);
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
			description: "Reply to a node that is waiting for a message (an agent that ended its turn with a question), or steer a running node: the message reaches it at its next step boundary.",
			inputSchema: { run_id: z.string(), node_id: z.string(), text: z.string() },
		},
		async ({ run_id, node_id, text }) => {
			try {
				await runs.resume(run_id, { sends: [{ node: node_id, text }] });
				const view = runs.view(run_id);
				return reply(summary(view), data(view));
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
				const view = runs.view(run_id);
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
				if (node_id) await runs.cancelNode(run_id, node_id);
				else await runs.resume(run_id, { cancel: true });
				const view = runs.view(run_id);
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
				return reply(renderTree(runs.view(run_id)));
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
				const page = nodeTranscript(runPaths(join(runsDir(runs.root), run_id)).dir, node_id, since, limit);
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
				const page = runLog(runPaths(join(runsDir(runs.root), run_id)).dir, since, limit);
				return paged(page.items.map((e) => `${e.seq}\t${e.event}`).join("\n"), page);
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"interrupt",
		{ description: "Abort a running node's current generation or tool, then deliver text (if given) to it.", inputSchema: { run_id: z.string(), node_id: z.string(), text: z.string().optional() } },
		async ({ run_id, node_id, text }) => {
			try {
				runs.interrupt(run_id, node_id, text);
				return reply(summary(runs.view(run_id)));
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
				await runs.pause(run_id);
				return reply(summary(runs.view(run_id)));
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
				await runs.unpause(run_id);
				return reply(summary(runs.view(run_id)));
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
				runs.control(run_id);
				const dir = runPaths(join(runsDir(runs.root), run_id)).dir;
				const timeoutMs = Math.min(timeout_s ?? WAIT_CAP_SECONDS, WAIT_CAP_SECONDS) * 1000;
				const items = await waitForAttention(dir, { timeoutMs });
				const view = runs.view(run_id);
				return reply(items ? describe(items) : `Run ${run_id} is still running.`, data(view));
			} catch (error) {
				return failure(error);
			}
		},
	);

	return server;
}
