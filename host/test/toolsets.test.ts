// Tool sources under bwrap: every connection to an MCP server gets its own
// scratch dir (server state never crosses agent calls), and a custom tool
// module is bundled and served under node from its own sandbox. Skipped
// without bwrap.

import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bwrapAvailable, Sandboxes } from "../src/host/confine.ts";
import { ToolSources } from "../src/host/toolsets.ts";
import { tmp } from "./util.ts";

const skip = bwrapAvailable() ? false : "bwrap cannot create a sandbox here";

/** A dependency-free MCP server: `probe` says whether its cwd already holds a marker, then leaves one. */
const SERVER = `import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
	const m = JSON.parse(line);
	if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0" } } });
	else if (m.method === "tools/list") send({ id: m.id, result: { tools: [{ name: "probe", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } });
	else if (m.method === "tools/call") {
		const seen = existsSync("marker");
		writeFileSync("marker", "x");
		send({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ seen, cwd: process.cwd() }) }] } });
	} else if (m.id !== undefined) send({ id: m.id, result: {} });
}
`;

test("each MCP connection gets its own scratch dir; a toolset runs bundled under node in its sandbox", { skip }, async () => {
	const srv = tmp();
	writeFileSync(join(srv, "server.mjs"), SERVER);
	const work = tmp();
	writeFileSync(
		join(work, "lib.ts"),
		`export const where = { name: "where", label: "where", description: "Where the tool runs", parameters: { type: "object", properties: {} }, replay: "safe",
	execute: async () => ({ content: [{ type: "text", text: process.cwd() }], details: undefined, structuredContent: { cwd: process.cwd(), secret: process.env.TOKEN ?? null, home: process.env.HOME } }) };\n`,
	);
	const node = { name: "node", check: ["node", "--version"] };
	const boxes = new Sandboxes({
		decls: { srv: { requires: [node], setup: [], mounts: ["srv"], base: null }, tools: { requires: [node], setup: [], mounts: [], base: null } },
		bins: { node: realpathSync(process.execPath) },
		mounts: { srv },
		mountDigests: {},
	});
	const sources = new ToolSources({
		decl: {
			mcp: { mcpServers: { probe: { command: "node", args: ["/w/srv/server.mjs"] } } },
			mcpServers: { probe: { sandbox: "srv", network: "none" } },
			toolsets: { "./lib.ts": { sandbox: "tools", secrets: ["TOKEN"], network: "none" } },
		} as never,
		workflowDir: work,
		runDir: tmp(),
		boxes,
		env: { TOKEN: "s3cret", OTHER: "nope" },
	});
	const probe = async (client: Awaited<ReturnType<ToolSources["connect"]>>) => JSON.parse(((await client.callTool("probe", {})).content[0] as { text: string }).text) as { seen: boolean; cwd: string };
	const a = await sources.connect({ kind: "mcp", server: "probe" });
	const b = await sources.connect({ kind: "mcp", server: "probe" });
	try {
		// Within one connection the server keeps its state ...
		assert.deepEqual(await probe(a), { seen: false, cwd: "/w" });
		assert.deepEqual(await probe(a), { seen: true, cwd: "/w" });
		// ... but another connection starts in its own scratch dir: it never sees the first's files.
		assert.deepEqual(await probe(b), { seen: false, cwd: "/w" });
	} finally {
		await a.close();
		await b.close();
	}
	const t = await sources.connect({ kind: "toolset", path: "./lib.ts" });
	try {
		const listed = await t.listTools();
		assert.deepEqual(listed.map((x) => [x.name, (x._meta as Record<string, unknown>)["wallis/name"], (x._meta as Record<string, unknown>)["wallis/replay"]]), [["where", "where", "safe"]]);
		const r = await t.callTool("where", {});
		// Its sandbox's scratch dir; only its declared secret.
		assert.deepEqual(r.structuredContent, { cwd: "/w", secret: "s3cret", home: "/w" });
	} finally {
		await t.close();
	}
});
