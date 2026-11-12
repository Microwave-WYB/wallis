// A dependency-free stdio MCP server for tests: `count` (read-only, structured) and `shout`.
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
	const m = JSON.parse(line);
	if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0" } } });
	else if (m.method === "tools/list")
		send({
			id: m.id,
			result: {
				tools: [
					{ name: "count", description: "Count the words of a text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, outputSchema: { type: "object", properties: { words: { type: "integer" } }, required: ["words"] }, annotations: { readOnlyHint: true } },
					{ name: "shout", description: "Upper-case a text", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
				],
			},
		});
	else if (m.method === "tools/call") {
		const { name, arguments: a } = m.params;
		if (name === "count") send({ id: m.id, result: { content: [{ type: "text", text: "counted" }], structuredContent: { words: a.text.split(/\s+/).filter(Boolean).length } } });
		else send({ id: m.id, result: { content: [{ type: "text", text: String(a.text ?? "").toUpperCase() }] } });
	} else if (m.id !== undefined) send({ id: m.id, result: {} });
}
