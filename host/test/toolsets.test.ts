// Tool sources: every connection to an MCP server gets its own scratch dir
// (server state never crosses agent calls), and a custom tool module is
// bundled and served under node from its own sandbox (skipped without
// bwrap). Without bwrap a local source is refused unless confinement is
// off, and unconfined it still runs in its connection's scratch dir.

import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bwrapAvailable, SandboxError, Sandboxes } from "../src/host/confine.ts";
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
		confinement: { type: "bwrap", boxes },
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

/** The probe server as a local source, run by this node, under a confinement. */
function probeSources(confinement: { type: "off" } | { type: "unavailable" }) {
	const work = tmp();
	writeFileSync(join(work, "server.mjs"), SERVER);
	const runDir = tmp();
	const sources = new ToolSources({
		decl: { mcp: { mcpServers: { probe: { command: process.execPath, args: [join(work, "server.mjs")] } } }, mcpServers: { probe: { sandbox: null, network: "full" } }, toolsets: { "./lib.ts": { sandbox: "tools", secrets: [], network: "full" } } } as never,
		workflowDir: work,
		runDir,
		confinement,
	});
	return { sources, runDir };
}

test("without bwrap a local tool source is refused (sandbox_unavailable), never run unconfined unless confinement is off", async () => {
	const { sources } = probeSources({ type: "unavailable" });
	for (const [source, key] of [
		[{ kind: "mcp", server: "probe" }, "mcp:probe"],
		[{ kind: "toolset", path: "./lib.ts" }, "toolset:./lib.ts"],
	] as const) {
		await assert.rejects(sources.connect(source), (e: unknown) => {
			assert.ok(e instanceof SandboxError, String(e));
			assert.deepEqual(e.refusal, { type: "sandbox_unavailable", source: key });
			return true;
		});
	}
});

test("unconfined (confinement off), each connection still runs in its own scratch dir", async () => {
	const { sources, runDir } = probeSources({ type: "off" });
	const probe = async (client: Awaited<ReturnType<ToolSources["connect"]>>) => JSON.parse(((await client.callTool("probe", {})).content[0] as { text: string }).text) as { seen: boolean; cwd: string };
	const a = await sources.connect({ kind: "mcp", server: "probe" });
	const b = await sources.connect({ kind: "mcp", server: "probe" });
	try {
		const first = await probe(a);
		assert.equal(first.seen, false);
		assert.ok(first.cwd.startsWith(join(realpathSync(runDir), "work", "mcp-probe-")), first.cwd);
		assert.equal((await probe(a)).seen, true);
		const other = await probe(b);
		assert.equal(other.seen, false);
		assert.notEqual(other.cwd, first.cwd);
		assert.ok(existsSync(join(first.cwd, "marker")));
	} finally {
		await a.close();
		await b.close();
	}
});
