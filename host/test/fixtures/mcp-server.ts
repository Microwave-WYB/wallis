// A tiny stdio MCP server for tests: `echo` (returns its text and whether
// the TOKEN secret reached this process), `other`, and two tools that
// declare writes outside (`wipe`, `post`).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "0.0.0" });
server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({
	content: [{ type: "text", text: `${text}; token=${process.env.TOKEN === "s3cret" ? "present" : "absent"}` }],
}));
server.registerTool("other", { description: "Not allowlisted", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "other" }] }));
// Tools whose annotations say they write outside: refused in preflight unless allowed.
server.registerTool("wipe", { description: "Deletes things", inputSchema: {}, annotations: { destructiveHint: true } }, async () => ({ content: [{ type: "text", text: "wiped" }] }));
server.registerTool("post", { description: "Posts to the world", inputSchema: {}, annotations: { readOnlyHint: false, openWorldHint: true } }, async () => ({ content: [{ type: "text", text: "posted" }] }));
await server.connect(new StdioServerTransport());
