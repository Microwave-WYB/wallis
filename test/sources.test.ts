// Tool sources: every connection to an MCP server gets its own scratch dir
// (server state never crosses calls), and a custom tool module is bundled
// into the store and served under node from its own sandbox, with only its
// secrets. Skipped without bwrap.

import assert from "node:assert/strict";
import { readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bwrapAvailable, resolvePrograms, type SandboxPlan } from "../src/host/sandbox.ts";
import { bundleToolset, toolId, ToolSources, writesOutside } from "../src/host/sources.ts";
import { Store } from "../src/host/store.ts";
import { resolveVolumes } from "../src/host/volumes.ts";
import { tmp } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";

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

const plan = (over: Partial<SandboxPlan> = {}): SandboxPlan => ({ programs: { ...resolvePrograms(["sh"]), node: realpathSync(process.execPath) }, volumes: [], environment: {}, devices: [], network: "none", ...over });

test("each MCP connection gets its own scratch dir; a server keeps state within one", { skip, timeout: 60_000 }, async () => {
	const srv = tmp();
	writeFileSync(join(srv, "server.mjs"), SERVER);
	const sources = new ToolSources(new Store(tmp()), join(tmp(), "work"));
	const box = plan({ volumes: resolveVolumes(["./:/srv:ro"], srv) });
	const probe = async (client: Awaited<ReturnType<ToolSources["connectServer"]>>) => JSON.parse(((await client.client.callTool("probe", {})).content[0] as { text: string }).text) as { seen: boolean; cwd: string };
	const a = await sources.connectServer({ command: "node", args: ["/srv/server.mjs"] }, box);
	const b = await sources.connectServer({ command: "node", args: ["/srv/server.mjs"] }, box);
	try {
		assert.deepEqual(await probe(a), { seen: false, cwd: "/w" });
		assert.deepEqual(await probe(a), { seen: true, cwd: "/w" });
		assert.deepEqual(await probe(b), { seen: false, cwd: "/w" });
		const [info] = await ToolSources.list(a.client, { kind: "mcp", server: "probe" });
		assert.equal(info!.id, "mcp:probe/probe");
		assert.equal(info!.name, "mcp__probe__probe");
		assert.equal(info!.replay, "safe");
	} finally {
		await a.close();
		await b.close();
	}
});

test("a toolset is bundled into the store (its identity is the bundle digest and export) and runs under node in its sandbox", { skip, timeout: 60_000 }, async () => {
	const work = tmp();
	writeFileSync(
		join(work, "lib.ts"),
		`import { Type } from "wallis";
export const where = { name: "where", label: "where", description: "Where the tool runs", parameters: Type.Object({}), outputSchema: Type.Object({ cwd: Type.String() }), replay: "safe",
	annotations: { readOnlyHint: true },
	execute: async () => ({ content: [{ type: "text", text: process.cwd() }], details: undefined, structuredContent: { cwd: process.cwd(), secret: process.env.TOKEN ?? null, other: process.env.OTHER ?? null, home: process.env.HOME } }) };
export const post = { name: "post", description: "Posts", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "posted" }] }) };
export const notATool = 3;\n`,
	);
	const store = new Store(tmp());
	const bundle = await bundleToolset(store, join(work, "lib.ts"));
	assert.equal(await bundleToolset(store, join(work, "lib.ts")), bundle, "the same source bundles to the same digest");
	process.env.OTHER = "nope";
	const sources = new ToolSources(store, join(tmp(), "work"));
	const t = await sources.connectToolset(bundle, plan(), { TOKEN: "s3cret" });
	try {
		const infos = await ToolSources.list(t.client, { kind: "toolset", bundle });
		assert.deepEqual(infos.map((i) => [i.id, i.name, i.replay, writesOutside(i.annotations)]), [
			[toolId({ kind: "toolset", bundle }, "post"), "post", "never", true],
			[toolId({ kind: "toolset", bundle }, "where"), "where", "safe", false],
		]);
		assert.deepEqual(infos[1]!.outputSchema, { type: "object", properties: { cwd: { type: "string" } }, required: ["cwd"] });
		const r = await t.client.callTool("where", {});
		assert.deepEqual(r.structuredContent, { cwd: "/w", secret: "s3cret", other: null, home: "/w" });
	} finally {
		await t.close();
	}
});

test("a source that dies at startup is reported with its stderr; closing a connection removes its scratch dir", { skip, timeout: 60_000 }, async () => {
	const srv = tmp();
	writeFileSync(join(srv, "dies.mjs"), 'console.error("cannot open the catalog: no such file"); process.exit(3);\n');
	writeFileSync(join(srv, "server.mjs"), SERVER);
	const work = join(tmp(), "work");
	const sources = new ToolSources(new Store(tmp()), work);
	const box = plan({ volumes: resolveVolumes(["./:/srv:ro"], srv) });
	await assert.rejects(sources.connectServer({ command: "node", args: ["/srv/dies.mjs"] }, box), (e: Error) => {
		assert.match(e.message, /^MCP server node did not start: /);
		assert.match(e.message, /its stderr:\ncannot open the catalog: no such file/);
		return true;
	});
	assert.deepEqual(readdirSync(work), [], "a failed start leaves no scratch dir");
	const a = await sources.connectServer({ command: "node", args: ["/srv/server.mjs"] }, box);
	assert.equal(readdirSync(work).length, 1);
	await a.close();
	assert.deepEqual(readdirSync(work), [], "a closed connection leaves no scratch dir");
});
