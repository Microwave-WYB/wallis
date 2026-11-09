// A tiny stdio MCP server for tests: `echo` (returns its text and whether
// the TOKEN secret reached this process), `other`, `search` (read-only,
// structured), and two tools that declare writes outside (`wipe`, `post`).
// With COUNT_FILE set, every tool call appends its name there, so tests can
// count calls of the outside world.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync } from "node:fs";
import { z } from "zod";

const counted = (tool: string) => {
	if (process.env.COUNT_FILE) appendFileSync(process.env.COUNT_FILE, `${tool}\n`);
};
const server = new McpServer({ name: "fixture", version: "0.0.0" });
server.registerTool("search", { description: "Search", inputSchema: { q: z.string() }, annotations: { readOnlyHint: true } }, async ({ q }) => {
	counted("search");
	return { content: [{ type: "text", text: JSON.stringify({ hits: [`${q}-1`, `${q}-2`] }) }], structuredContent: { hits: [`${q}-1`, `${q}-2`] } };
});
server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({
	content: [{ type: "text", text: `${text}; token=${process.env.TOKEN === "s3cret" ? "present" : "absent"}` }],
}));
server.registerTool("other", { description: "Not allowlisted", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "other" }] }));
// Tools whose annotations say they write outside: refused in preflight unless allowed.
server.registerTool("wipe", { description: "Deletes things", inputSchema: {}, annotations: { destructiveHint: true } }, async () => ({ content: [{ type: "text", text: "wiped" }] }));
server.registerTool("post", { description: "Posts to the world", inputSchema: {}, annotations: { readOnlyHint: false, openWorldHint: true } }, async () => {
	counted("post");
	return { content: [{ type: "text", text: "posted" }] };
});
await server.connect(new StdioServerTransport());
