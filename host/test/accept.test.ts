// State-coverage acceptance: a faux-driven run (fixtures/accept) enters
// every attention kind and the orchestrator resolves each, once through
// the CLI (detached hosts) and once through the MCP server (stdio):
// explicit and implicit asks, turn_limit, interrupted, an orchestrator node
// (an invalid submit, then a valid one), a tool approval (approve, and
// reject with a reason), budget_reached, executor_unavailable (a rebind),
// paused, a held node failure (restart), stopped (the host is killed,
// resume) and finished. The fixture MCP server counts its calls: replay,
// resume and fork never call it again.

import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cli, cliEnv, onlyRun, tmp, wallis } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const executor = resolve(here, "fixtures/accept-executor.ts");

type Item = { kind: string; node?: string; via?: string; question?: string; reason?: { type: string; alias?: string }; server?: string; tool?: string; actions: { verb: string; args: Record<string, unknown> }[] };

/** A project with the acceptance workflow; its mcp.json points at the fixture server. */
function acceptProject() {
	const root = tmp("wallis-accept-");
	const dir = join(root, ".agents", "workflows", "accept");
	cpSync(resolve(here, "fixtures/accept"), dir, { recursive: true });
	const mcp = { mcpServers: { fx: { command: process.execPath, args: [resolve(here, "fixtures/mcp-server.ts")], env: { COUNT_FILE: "${COUNT_FILE}" } } } };
	writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp));
	const env = { COUNT_FILE: join(root, "count.txt"), ACCEPT_KILL_FILE: join(root, "kill.flag") };
	return { root, env, count: () => (existsSync(env.COUNT_FILE) ? readFileSync(env.COUNT_FILE, "utf8").trim().split("\n") : []), kill: () => writeFileSync(env.ACCEPT_KILL_FILE, "") };
}

/** What the scenario needs from an orchestrator: the verbs, and the run's pending items. */
interface Orchestrator {
	start(): Promise<void>;
	items(): Promise<Item[]>;
	/** Waits for the next attention, then returns every pending item. */
	wait(): Promise<Item[]>;
	nodes(): Promise<{ id: string; type: string }[]>;
	send(node: string, text: string, turns?: number): Promise<string>;
	/** Resolves with null, or with the refusal. */
	submit(node: string, value: unknown): Promise<{ type: string } | null>;
	interrupt(node: string, agent: string): Promise<void>;
	pause(): Promise<void>;
	resume(options?: { budget?: { turns: number }; models?: Record<string, string> }): Promise<void>;
	/** May lose its host on the way (the fixture kills it at the last step). */
	restart(node: string, note: string): Promise<void>;
	outcome(): Promise<{ type: string; value?: Record<string, unknown> }>;
}

const label = (i: Item) => [i.kind, i.via ?? (i.kind === "run_idle" ? i.reason?.type : i.node) ?? ""].join(":");

async function scenario(o: Orchestrator, project: ReturnType<typeof acceptProject>) {
	await o.start();
	// An explicit ask, through the ask tool.
	let items = await o.items();
	assert.deepEqual(items.map(label), ["agent_ask:ask_tool"]);
	assert.equal(items[0]!.question, "Which colour should the sheet use?");
	assert.deepEqual(items[0]!.actions.map((a) => a.verb), ["send", "restart", "cancel"]);
	assert.match(await o.send("#1:0", "blue"), /delivered to #1:0 as the reply to: Which colour should the sheet use\?/);
	// The turn budget (2) holds the next call.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["run_idle:budget_reached"]);
	assert.deepEqual(items[0]!.actions.map((a) => a.verb), ["resume"]);
	await o.resume({ budget: { turns: 100 } });
	// An implicit ask: the turn ended with a question, in the same session.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["agent_ask:end_of_turn"]);
	assert.equal(items[0]!.node, "#1:1");
	assert.match(await o.send("#1:1", "the cool one"), /as the reply to: Do you mean the warm or the cool variant\?/);
	// The turn limit: more turns with the message.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["turn_limit:#2:0"]);
	assert.deepEqual(items[0]!.actions[0]!.args.required, ["turns"]);
	assert.match(await o.send("#2:0", "finish", 2), /with 2 more turns/);
	// Paused while a node runs, then the node is interrupted.
	for (let i = 0; i < 300 && !(await o.nodes()).some((n) => n.id === "#3:0" && n.type === "node_running"); i++) await new Promise((r) => setTimeout(r, 100));
	await o.pause();
	await o.interrupt("#3:0", "worker");
	items = await o.wait();
	assert.deepEqual(items.map(label).sort(), ["interrupted:#3:0", "run_idle:paused_by_user"]);
	await o.resume();
	assert.match(await o.send("#3:0", "carry on"), /delivered to #3:0 after its interrupt/);
	// A tool approval: a rejection needs a reason; then approve.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["approval_pending:#4:0"]);
	assert.deepEqual([items[0]!.server, items[0]!.tool], ["fx", "post"]);
	assert.equal((await o.submit("#4:0", { type: "reject", reason: "" }))?.type, "invalid_answer");
	assert.equal(await o.submit("#4:0", { type: "approve" }), null);
	// The next approval, rejected with a reason.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["approval_pending:#5:0"]);
	assert.equal(await o.submit("#5:0", { type: "reject", reason: "not today" }), null);
	// An orchestrator node: an invalid submit is refused and it stays pending; then a valid one.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["orchestrator_pending:#6"]);
	const answer = items[0]!.actions[0]!.args as { properties: { value: { properties: { choice: unknown } } } };
	assert.ok(answer.properties.value.properties.choice, "the action carries the answer schema");
	assert.equal((await o.submit("#6", { choice: "c" }))?.type, "invalid_answer");
	assert.deepEqual((await o.items()).map(label), ["orchestrator_pending:#6"]);
	assert.equal(await o.submit("#6", { choice: "a" }), null);
	// The executor cannot serve an alias: rebind it.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["run_idle:executor_unavailable"]);
	assert.equal(items[0]!.reason!.alias, "flaky");
	await o.resume({ models: { flaky: "faux/faux-1" } });
	// A failure the body does not handle holds the run; a restart with a note fixes it.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["node_failed:#8:0"]);
	// The host dies at the last step: the run is stopped; resume finishes it.
	project.kill();
	await o.restart("#8:0", "try again");
	items = await o.wait();
	assert.deepEqual(items.map(label), ["stopped:"]);
	await o.resume();
	items = await o.wait();
	assert.deepEqual(items.map(label), ["finished:"]);
	assert.deepEqual(await o.outcome(), {
		type: "done",
		value: {
			found: ["looks-1", "looks-2"],
			asked: "blue",
			implicit: "the cool one",
			limit: "finished",
			slowed: "carry on",
			approved: "posted",
			rejected: "The orchestrator rejected this call: not today",
			picked: "a",
			flaky: "served",
			fragile: "recovered",
			last: "done",
		},
	});
	// The outside world was called once per call: the resume replayed the journal.
	assert.deepEqual(project.count(), ["search", "post"]);
}

test("acceptance through the CLI: every attention kind, entered and resolved", { timeout: 240_000 }, async () => {
	const project = acceptProject();
	const w = (...args: string[]) => wallis(project.root, args, project.env);
	let id = "";
	const ok = (r: ReturnType<typeof wallis>) => {
		assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
		return r.stdout;
	};
	const status = () => JSON.parse(ok(w("status", id, "--json"))) as { attention: Item[]; nodes: { id: string; type: string }[]; status: { outcome?: { type: string; value?: Record<string, unknown> } } };
	const o: Orchestrator = {
		start: async () => {
			ok(w("run", "accept", "--input", "null", "--executor", executor));
			id = onlyRun(project.root);
		},
		items: async () => status().attention,
		wait: async () => {
			const r = w("wait", id, "--timeout", "60", "--json");
			assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
			return status().attention;
		},
		nodes: async () => status().nodes,
		send: async (node, text, turns) => ok(w("send", id, node, text, ...(turns ? ["--turns", String(turns)] : []))),
		submit: async (node, value) => {
			const r = w("submit", id, node, JSON.stringify(value));
			if (r.status === 0) return null;
			const refused = /^Refused: (.*)$/m.exec(r.stdout);
			assert.ok(refused, `${r.stdout}\n${r.stderr}`);
			return JSON.parse(refused[1]!) as { type: string };
		},
		interrupt: async (node) => void ok(w("interrupt", id, node)),
		pause: async () => void ok(w("pause", id)),
		resume: async (options = {}) =>
			void ok(
				w(
					"resume",
					id,
					...(options.budget ? ["--budget", `turns=${options.budget.turns}`] : []),
					...Object.entries(options.models ?? {}).flatMap(([a, m]) => ["--model", `${a}=${m}`]),
				),
			),
		restart: async (node, note) => {
			const r = w("restart", id, node, note);
			assert.ok(r.status === 0 || r.signal !== null, `${r.stdout}\n${r.stderr}`);
		},
		outcome: async () => status().status.outcome!,
	};
	await scenario(o, project);
	// A fork re-executes against the copied journal: nothing outside is called again.
	ok(w("fork", id));
	assert.deepEqual(project.count(), ["search", "post"]);
});

test("acceptance through MCP: every attention kind, entered and resolved", { timeout: 240_000 }, async () => {
	const project = acceptProject();
	let client: Client | null = null;
	let id = "";
	const connect = async () => {
		const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "serve", "--root", project.root, "--executor", executor], env: cliEnv(project.env), stderr: "pipe" });
		client = new Client({ name: "accept", version: "0.0.0" });
		await client.connect(transport);
	};
	type Reply = { text: string; data: Record<string, unknown>; isError: boolean };
	const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
		const r = (await client!.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
		return { text: r.content[0]!.text, data: r.content[1] ? (JSON.parse(r.content[1].text) as Record<string, unknown>) : {}, isError: r.isError === true };
	};
	const run = async () => (await call("get_run", { run_id: id })).data as { attention: Item[]; nodes: { id: string; type: string }[]; status: { outcome?: { type: string; value?: Record<string, unknown> } } };
	const o: Orchestrator = {
		start: async () => {
			await connect();
			const started = await call("run", { workflow: "accept", input: null });
			assert.equal(started.isError, false, started.text);
			id = started.data.run_id as string;
			await call("wait", { run_id: id, timeout_s: 30 });
		},
		items: async () => (await run()).attention,
		wait: async () => {
			for (let i = 0; i < 4; i++) {
				const r = await call("wait", { run_id: id, timeout_s: 30 });
				if ((r.data.items as Item[]).length > 0) break;
			}
			return (await run()).attention;
		},
		nodes: async () => (await run()).nodes,
		send: async (node, text, turns) => {
			const r = await call("send", { run_id: id, node_id: node, text, ...(turns ? { turns } : {}) });
			assert.equal(r.isError, false, r.text);
			return r.data.delivery as string;
		},
		submit: async (node, value) => {
			const r = await call("submit_result", { run_id: id, node_id: node, value });
			return r.isError ? (r.data.refusal as { type: string }) : null;
		},
		interrupt: async (node, agent) => {
			const r = await call("interrupt", { run_id: id, node_id: node, agent });
			assert.equal(r.isError, false, r.text);
		},
		pause: async () => void assert.equal((await call("pause", { run_id: id })).isError, false),
		resume: async (options = {}) => {
			const r = await call("resume", { run_id: id, ...options });
			assert.equal(r.isError, false, r.text);
		},
		restart: async (node, note) => {
			// The server is the host: it dies at the last step, perhaps before it answers.
			await call("restart", { run_id: id, node_id: node, note }).catch(() => null);
			for (let i = 0; i < 100; i++) {
				const pid = Number(readFileSync(join(project.root, ".wallis", "runs", id, "lock"), "utf8").trim() || 0);
				const alive = (() => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				})();
				if (!alive) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			await client!.close().catch(() => {});
			await connect();
		},
		outcome: async () => (await run()).status.outcome!,
	};
	try {
		await scenario(o, project);
	} finally {
		await (client as Client | null)?.close().catch(() => {});
	}
});
