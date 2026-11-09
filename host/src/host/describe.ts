// What a workflow declares, for its orchestrator (`wallis describe`, MCP
// `describe`): its input and output, its agents and the MCP tools they use
// (direct or `ask`), its MCP tool nodes, and the questions it may ask the
// orchestrator (orchestrator nodes, with the schema of the answer).

import type { Json } from "../sdk/index.ts";
import { declarationsOf } from "./sandbox.ts";

export async function describeWorkflow(path: string): Promise<Json> {
	const d = await declarationsOf(path);
	return JSON.parse(
		JSON.stringify({
			name: d.core.name,
			input: d.input,
			output: d.output,
			budget: d.core.budget,
			agents: Object.fromEntries(Object.entries(d.agents).map(([name, a]) => [name, { model: a.model, max_turns: a.max_turns, steerable: a.steerable, sandbox: a.sandbox, mcp: a.mcp }])),
			commands: Object.keys(d.commands),
			mcp_tools: Object.fromEntries(Object.entries(d.tools).map(([name, t]) => [name, { server: t.server, tool: t.tool, input: t.input, output: t.output }])),
			orchestrators: Object.fromEntries(Object.entries(d.orchestrators).map(([name, o]) => [name, { description: o.description, input: o.input, answer: o.output }])),
		}),
	) as Json;
}
