// A tiny stdio MCP server for tests: `echo` (returns its text and whether
// the TOKEN secret reached this process) and `other`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "0.0.0" });
server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({
	content: [{ type: "text", text: `${text}; token=${process.env.TOKEN === "s3cret" ? "present" : "absent"}` }],
}));
server.registerTool("other", { description: "Not allowlisted", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "other" }] }));
await server.connect(new StdioServerTransport());
