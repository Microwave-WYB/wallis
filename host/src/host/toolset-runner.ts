// The runner of a custom tool module, bundled with it (toolsets.ts) and run
// under node in the toolset's own sandbox. It serves each exported tool (a
// pi AgentTool plus MCP annotations) over stdio with the official MCP SDK:
// `parameters` become `inputSchema`; `outputSchema`, `structuredContent` and
// `annotations` pass through; the export name and `replay` go in `_meta`.
// A cancelled request aborts the tool's `signal`. Nothing else is offered
// (no resources, prompts, sampling or elicitation).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type Tool = {
	name: string;
	description?: string;
	parameters: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
	replay?: "never" | "safe";
	execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: unknown[]; structuredContent?: unknown; isError?: boolean }>;
};

const isTool = (v: unknown): v is Tool => typeof v === "object" && v !== null && typeof (v as Tool).name === "string" && typeof (v as Tool).execute === "function";

export async function serve(module: Record<string, unknown>): Promise<void> {
	const tools = Object.entries(module).filter((e): e is [string, Tool] => isTool(e[1]));
	const byName = new Map(tools.map(([, t]) => [t.name, t]));
	const server = new Server({ name: "wallis-toolset", version: "0.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map(([key, t]) => ({
			name: t.name,
			description: t.description ?? t.name,
			inputSchema: t.parameters,
			...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
			...(t.annotations ? { annotations: t.annotations } : {}),
			_meta: { "wallis/export": key, "wallis/replay": t.replay ?? "never" },
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const tool = byName.get(request.params.name);
		if (!tool) return { content: [{ type: "text", text: `no tool ${request.params.name}` }], isError: true };
		try {
			const r = await tool.execute(String(extra.requestId), request.params.arguments ?? {}, extra.signal);
			return { content: r.content, ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}), isError: r.isError === true } as never;
		} catch (error) {
			return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
		}
	});
	await server.connect(new StdioServerTransport());
	// The host is gone (or closed the connection): so is this process, with any call in flight.
	process.stdin.on("close", () => process.exit(0));
}
