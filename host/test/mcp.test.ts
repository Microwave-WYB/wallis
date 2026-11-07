// The MCP server driving the `ask` workflow: run, a question, send, get_run,
// wait. In-process over the SDK's in-memory transport, plus a stdio smoke
// test of `wallis serve`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/host/mcp.ts";
import { loadExecutor, Runs } from "../src/host/runs.ts";
import { cli, fakeExecutor, project } from "./util.ts";

type Result = { content: { type: string; text: string }[]; isError?: boolean };

async function connect(root: string) {
	const server = createMcpServer(new Runs(root, await loadExecutor(fakeExecutor), fakeExecutor));
	const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "test", version: "0.0.0" });
	await client.connect(clientSide);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: args })) as Result;
		return { text: r.content[0]!.text, data: r.content[1] ? JSON.parse(r.content[1].text) : null, isError: r.isError === true };
	};
	return { client, call, close: () => client.close() };
}

test("MCP: run a two-node workflow with a question through run, send, get_run and wait", async () => {
	const root = project();
	const { client, call, close } = await connect(root);
	try {
		assert.match(client.getInstructions() ?? "", /npx wallis wait <run_id>/);
		const tools = (await client.listTools()).tools.map((t) => t.name).sort();
		assert.deepEqual(tools, ["cancel", "get_run", "run", "send", "wait"]);
		assert.match((await client.listTools()).tools.find((t) => t.name === "run")!.description!, /ask, two-node/);

		const started = await call("run", { workflow: "ask", input: { topic: "folds" }, seed: 3 });
		assert.equal(started.isError, false, started.text);
		const runId = started.data.run_id as string;
		assert.match(started.text, new RegExp(`run in the background: npx wallis wait ${runId}`));
		// Every result appends what is pending: here, the question.
		assert.match(started.text, /Pending in this project:[\s\S]*Who is the audience/);

		const asked = await call("wait", { run_id: runId, timeout_s: 10 });
		assert.match(asked.text, /waiting for a reply/);
		const before = await call("get_run", { run_id: runId });
		assert.deepEqual(before.data.status, { type: "idle", reason: null });
		assert.deepEqual(before.data.nodes[0].status, { type: "node_idle", last_message: "Who is the audience: experts or newcomers?" });

		const refused = await call("send", { run_id: runId, node_id: "#1", text: "hi" });
		assert.equal(refused.isError, true);
		assert.deepEqual(refused.data.refusal, { type: "not_idle", node: "#1" });

		const sent = await call("send", { run_id: runId, node_id: "#0", text: "newcomers" });
		assert.equal(sent.isError, false, sent.text);
		const done = await call("wait", { run_id: runId, timeout_s: 10 });
		assert.match(done.text, /finished, done/);
		const after = await call("get_run", { run_id: runId });
		assert.equal(after.data.status.type, "finished");
		assert.deepEqual(after.data.nodes.map((n: { agent: string; status: { type: string } }) => [n.agent, n.status.type]), [["scout", "node_done"], ["writer", "node_done"]]);
		assert.match(after.text, /Nothing else is pending/);

		// wait returns "still running" at its cap; cancel ends an idle run.
		const second = await call("run", { workflow: "ask", input: { topic: "x" } });
		const cancelled = await call("cancel", { run_id: second.data.run_id });
		assert.deepEqual(cancelled.data.status, { type: "finished", outcome: { type: "cancelled" } });
	} finally {
		await close();
	}
});

test("MCP over stdio: wallis serve lists tools and runs a workflow", async () => {
	const root = project();
	const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "serve", "--root", root, "--executor", fakeExecutor], stderr: "pipe" });
	const client = new Client({ name: "test", version: "0.0.0" });
	await client.connect(transport);
	try {
		assert.equal((await client.listTools()).tools.length, 5);
		const r = (await client.callTool({ name: "run", arguments: { workflow: "two-node", input: { topic: "x" } } })) as Result;
		const runId = JSON.parse(r.content[1]!.text).run_id;
		const w = (await client.callTool({ name: "wait", arguments: { run_id: runId, timeout_s: 10 } })) as Result;
		assert.match(w.content[0]!.text, /finished, done/);
	} finally {
		await client.close();
	}
});
