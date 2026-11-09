// The MCP server driving the `ask` workflow: run, a question, send, get_run,
// wait. In-process over the SDK's in-memory transport, plus a stdio smoke
// test of `wallis serve`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/host/mcp.ts";
import { bwrapAvailable, readMeta, runPaths } from "../src/host/index.ts";
import { join } from "node:path";
import { loadExecutor, Runs } from "../src/host/runs.ts";
import { cli, fakeExecutor, project } from "./util.ts";

type Result = { content: { type: string; text: string }[]; isError?: boolean };

async function connect(root: string, owner = "harness:mcp-test") {
	const server = await createMcpServer(new Runs(root, await loadExecutor(fakeExecutor), fakeExecutor, owner));
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
		assert.deepEqual(tools, ["cancel", "describe", "get_run", "interrupt", "list_runs", "node_transcript", "pause", "pending", "restart", "resume", "run", "run_log", "run_tree", "send", "submit_result", "wait"]);
		// interrupt enumerates only steerable agents, from the declarations.
		for (const name of ["interrupt"]) {
			const schema = (await client.listTools()).tools.find((t) => t.name === name)!.inputSchema as unknown as { properties: { agent: { enum: string[] } } };
			assert.deepEqual(schema.properties.agent.enum, ["attempt", "merger", "planner", "scout", "writer"], "judge is not steerable");
		}
		const badId = await call("get_run", { run_id: "../etc" });
		assert.equal(badId.isError, true);
		assert.match(badId.text, /not a run id/);
		assert.match((await client.listTools()).tools.find((t) => t.name === "run")!.description!, /ask, fanout, two-node/);

		const started = await call("run", { workflow: "ask", input: { topic: "folds" }, seed: 3 });
		assert.equal(started.isError, false, started.text);
		const runId = started.data.run_id as string;
		assert.match(started.text, new RegExp(`run in the background: npx wallis wait ${runId}`));
		const asked = await call("wait", { run_id: runId, timeout_s: 10 });
		assert.match(asked.text, /ended its turn with a question/);
		// Every result appends what is pending: here, the question.
		const status = await call("get_run", { run_id: runId });
		assert.match(status.text, /Pending in this project:[\s\S]*Who is the audience/);
		const before = await call("get_run", { run_id: runId });
		assert.deepEqual(before.data.status, { type: "idle", reason: null });
		assert.equal(before.data.nodes[0].type, "node_idle");
		assert.deepEqual(before.data.nodes[0].cause, { type: "question", message: "Who is the audience: experts or newcomers?" });

		const refused = await call("send", { run_id: runId, node_id: "#1:0", text: "hi" });
		assert.equal(refused.isError, true);
		assert.deepEqual(refused.data.refusal, { type: "not_idle", node: "#1:0" });
		const notRunning = await call("interrupt", { run_id: runId, node_id: "#0:0", agent: "scout" });
		assert.deepEqual(notRunning.data.refusal, { type: "node_not_running", node: "#0:0" });
		// The pending item, structured: its kind, question and actions.
		const items = (await call("pending", {})).data as unknown as { kind: string; via: string; question: string; actions: { verb: string }[] }[];
		assert.deepEqual(items.map((i) => [i.kind, i.via, i.question, i.actions.map((a) => a.verb)]), [["agent_ask", "end_of_turn", "Who is the audience: experts or newcomers?", ["send", "restart", "cancel"]]]);

		const sent = await call("send", { run_id: runId, node_id: "#0:0", text: "newcomers" });
		assert.equal(sent.isError, false, sent.text);
		assert.match(sent.text, /Sent: delivered to #0:0 as the reply to: Who is the audience/);
		const done = await call("wait", { run_id: runId, timeout_s: 10 });
		assert.match(done.text, /finished, done/);
		const after = await call("get_run", { run_id: runId });
		assert.equal(after.data.status.type, "finished");
		assert.deepEqual(after.data.nodes.map((n: { agent: string; type: string }) => [n.agent, n.type]), [["scout", "node_done"], ["writer", "node_done"]]);
		assert.match(after.text, /Nothing else is pending/);

		// Monitoring for the owner: runs, tree, log and transcript, capped with cursors.
		assert.match((await call("list_runs", {})).text, new RegExp(`${runId}  ask  finished`));
		assert.match((await call("run_tree", { run_id: runId })).text, /#0  session scout\n {4}#0:0  scout  fake\/default  done \(submitted\)  inbox: answer@1\n {2}#1  session writer/);
		const log1 = await call("run_log", { run_id: runId, limit: 3 });
		assert.equal(log1.data.items.length, 3);
		assert.equal(log1.data.next, 3);
		const log2 = await call("run_log", { run_id: runId, since: log1.data.next });
		assert.equal(log2.data.items[0].seq, 3);
		const transcript = await call("node_transcript", { run_id: runId, node_id: "#0:0" });
		assert.match(transcript.text, /"kind":"user","text":"newcomers"/);

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
		assert.equal((await client.listTools()).tools.length, 16);
		const r = (await client.callTool({ name: "run", arguments: { workflow: "two-node", input: { topic: "x" } } })) as Result;
		const runId = JSON.parse(r.content[1]!.text).run_id;
		const w = (await client.callTool({ name: "wait", arguments: { run_id: runId, timeout_s: 10 } })) as Result;
		assert.match(w.content[0]!.text, /finished, done/);
	} finally {
		await client.close();
	}
});

test("MCP: without a command runner from the executor module, commands run as sandboxed processes (as in the CLI)", { skip: !bwrapAvailable() && "bubblewrap unavailable" }, async () => {
	const root = project();
	const { call, close } = await connect(root);
	try {
		const started = await call("run", { workflow: "fanout", input: null });
		const done = await call("wait", { run_id: started.data.run_id, timeout_s: 20 });
		// The fanout's train command really ran (sh in bwrap) and printed its JSON.
		assert.match(done.text, /finished, done: .*"trained":\{"budget":null\}/);
		const meta = readMeta(runPaths(join(root, ".wallis", "runs", started.data.run_id)))!;
		assert.equal(meta.confined, true);
		assert.ok(meta.bins!.sh!.path.startsWith("/"));
	} finally {
		await close();
	}
});

test("MCP: runs belong to the server's harness; another harness may read but not answer", async () => {
	const root = project();
	const mine = await connect(root, "harness:mine");
	const theirs = await connect(root, "harness:theirs");
	try {
		const started = await mine.call("run", { workflow: "ask", input: { topic: "x" } });
		const runId = started.data.run_id as string;
		await mine.call("wait", { run_id: runId, timeout_s: 10 });
		const read = await theirs.call("get_run", { run_id: runId });
		assert.equal(read.isError, false);
		assert.match(read.text, /Nothing else is pending/, "pending lists only own runs");
		const send = await theirs.call("send", { run_id: runId, node_id: "#0:0", text: "hi" });
		assert.equal(send.isError, true);
		assert.match(send.text, /owned by harness:mine/);
	} finally {
		await mine.close();
		await theirs.close();
	}
});
