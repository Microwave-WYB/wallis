// What a workflow declares, for its orchestrator (`wallis describe`, MCP
// `describe`): its input and output, its agents (model, workspace access,
// tools), its tool sources, the questions it may ask the orchestrator
// (orchestrator nodes, with the schema of the answer), and the tool
// warnings of its latest preflight in this project (tools given to agents
// that may write outside; tools a whole MCP server leaves out).

import { resolve } from "node:path";
import type { Json } from "../sdk/index.ts";
import { declarationsOf } from "./sandbox.ts";
import { listRuns, readMeta } from "./store.ts";

const ACCESS = ["none", "read", "write", "exec"] as const;

export async function describeWorkflow(path: string, root: string): Promise<Json> {
	const d = await declarationsOf(path);
	const latest = listRuns(root)
		.map((p) => ({ id: p.id, meta: readMeta(p) }))
		.filter((r) => r.meta !== null && resolve(r.meta.workflow) === resolve(path) && r.meta.warnings !== undefined)
		.at(-1);
	return JSON.parse(
		JSON.stringify({
			name: d.core.name,
			input: d.input,
			output: d.output,
			budget: d.core.budget,
			agents: Object.fromEntries(
				Object.entries(d.agents).map(([name, a]) => [name, { model: a.model, max_turns: a.max_turns, steerable: a.steerable, workspace: { access: ACCESS[a.access], sandbox: a.sandbox }, tools: a.tools }]),
			),
			commands: Object.keys(d.commands),
			toolsets: d.toolsets,
			mcp_servers: Object.keys((d.mcp as { mcpServers?: object } | null)?.mcpServers ?? {}),
			orchestrators: Object.fromEntries(Object.entries(d.orchestrators).map(([name, o]) => [name, { description: o.description, input: o.input, answer: o.output }])),
			tool_warnings: latest ? { from_run: latest.id, warnings: latest.meta!.warnings } : null,
		}),
	) as Json;
}
