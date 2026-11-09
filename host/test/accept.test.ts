// State-coverage acceptance: a faux-driven run (fixtures/accept) enters
// every attention kind and the orchestrator resolves each, once through
// the CLI (detached hosts) and once through the MCP server (stdio): an ask,
// an end of turn without a result, turn_limit, paused and interrupted, the
// host killed during a tool call that is not safe to repeat (stopped, then
// outcome_unknown, then a restart that retries it), orchestrator nodes (an
// invalid submit then a valid one; one asked again, then cancelled),
// budget_reached, executor_unavailable (a rebind), a held node failure
// (restart) and finished. The fixture tools count their calls: resume,
// replay and fork never call the outside world again; through the CLI the
// run is also forked mid-run, and the fork keeps its work dirs.

import assert from "node:assert/strict";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { blobPath } from "../src/host/artifacts.ts";
import { readMeta, runPaths } from "../src/host/store.ts";
import { cli, cliEnv, lines, onlyRun, runDir, tmp, wallis } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const executor = resolve(here, "fixtures/accept-executor.ts");

type Item = { kind: string; node?: string; question?: string; text?: string; tool?: string; reason?: { type: string; alias?: string }; actions: { verb: string; args: Record<string, unknown> }[] };

/** A project with the acceptance workflow; its mcp.json points at the fixture server. */
function acceptProject() {
	const root = tmp("wallis-accept-");
	const dir = join(root, ".agents", "workflows", "accept");
	cpSync(resolve(here, "fixtures/accept"), dir, { recursive: true });
	const mcp = { mcpServers: { fx: { command: process.execPath, args: [resolve(here, "fixtures/mcp-server.ts")], env: { COUNT_FILE: "${COUNT_FILE}" } } } };
	writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp));
	// The tools module is bundled by wallis: it resolves `wallis` itself.
	const env = { COUNT_FILE: join(root, "count.txt") };
	return { root, env, count: () => (existsSync(env.COUNT_FILE) ? readFileSync(env.COUNT_FILE, "utf8").trim().split("\n") : []) };
}

/** Kills the process driving the run (its lock holder). */
function killHost(root: string, id: string) {
	const pid = Number(readFileSync(join(runDir(root, id), "lock"), "utf8").trim());
	process.kill(pid, "SIGKILL");
	for (let i = 0; i < 100; i++) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		spinSleep(50);
	}
}
const spinSleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** What the scenario needs from an orchestrator: the verbs, and the run's pending items. */
interface Orchestrator {
	readonly id: () => string;
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
	restart(node: string, note?: string): Promise<void>;
	cancelNode(node: string): Promise<void>;
	/** The host dies; the orchestrator reconnects if it must. */
	kill(): Promise<void>;
	outcome(): Promise<{ type: string; value?: Record<string, unknown> }>;
	/** At the ended-without-result step (CLI only). */
	midway?(): Promise<void>;
}

const label = (i: Item) => [i.kind, i.kind === "run_idle" ? i.reason?.type : (i.node ?? "")].join(":");

async function scenario(o: Orchestrator, project: ReturnType<typeof acceptProject>) {
	await o.start();
	// An ask, through the ask tool.
	let items = await o.items();
	assert.deepEqual(items.map(label), ["agent_ask:#1"]);
	assert.equal(items[0]!.question, "Which colour should the sheet use?");
	assert.deepEqual(items[0]!.actions.map((a) => a.verb), ["send", "restart", "cancel"]);
	assert.match(await o.send("#1", "blue"), /delivered to #1 as the reply to: Which colour should the sheet use\?/);
	// The turn budget (2) holds the next call.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["run_idle:budget_reached"]);
	await o.resume({ budget: { turns: 100 } });
	// The turn ended with neither a result nor a question, in the same session.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["ended_without_result:#2"]);
	assert.equal(items[0]!.text, "I could not decide between the warm and the cool variant.");
	await o.midway?.();
	assert.match(await o.send("#2", "the cool one"), /delivered to #2 as the reply to: I could not decide/);
	// The turn limit: more turns with the message.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["turn_limit:#3"]);
	assert.match(await o.send("#3", "finish", 2), /with 2 more turns/);
	// Paused while a node runs, then the node is interrupted.
	for (let i = 0; i < 300 && !(await o.nodes()).some((n) => n.id === "#4" && n.type === "node_running"); i++) await new Promise((r) => setTimeout(r, 100));
	await o.pause();
	await o.interrupt("#4", "worker");
	items = await o.wait();
	assert.deepEqual(items.map(label).sort(), ["interrupted:#4", "run_idle:paused_by_user"]);
	await o.resume();
	assert.match(await o.send("#4", "carry on"), /delivered to #4 after its interrupt/);
	// The host dies while the upload tool runs: the run is stopped; on resume the call is not
	// safe to repeat, so its outcome is unknown; a restart retries it.
	for (let i = 0; i < 300 && !project.count().includes("upload"); i++) await new Promise((r) => setTimeout(r, 100));
	await o.kill();
	items = await o.wait();
	assert.deepEqual(items.map(label), ["stopped:"]);
	await o.resume();
	items = await o.wait();
	assert.deepEqual(items.map(label), ["outcome_unknown:#5"]);
	assert.equal(items[0]!.tool, "upload");
	assert.deepEqual(items[0]!.actions.map((a) => a.verb), ["restart", "cancel"]);
	await o.restart("#5");
	// An orchestrator node: an invalid submit is refused and it stays pending; then a valid one.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["orchestrator_pending:#6"]);
	const answer = items[0]!.actions[0]!.args as { properties: { value: { properties: { choice: unknown } } } };
	assert.ok(answer.properties.value.properties.choice, "the action carries the answer schema");
	assert.deepEqual(items[0]!.actions.map((a) => a.verb), ["submit_result", "restart", "cancel"]);
	assert.equal((await o.submit("#6", { choice: "c" }))?.type, "invalid_answer");
	assert.deepEqual((await o.items()).map(label), ["orchestrator_pending:#6"]);
	assert.equal(await o.submit("#6", { choice: "a" }), null);
	// Another one is asked again (restart), then cancelled: the body catches the typed failure.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["orchestrator_pending:#7"]);
	await o.restart("#7");
	assert.deepEqual((await o.items()).map(label), ["orchestrator_pending:#7"]);
	await o.cancelNode("#7");
	// The executor cannot serve an alias: rebind it.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["run_idle:executor_unavailable"]);
	assert.equal(items[0]!.reason!.alias, "flaky");
	await o.resume({ models: { flaky: "faux/faux-1" } });
	// A failure the body does not handle holds the run; a restart with a note fixes it.
	items = await o.wait();
	assert.deepEqual(items.map(label), ["node_failed:#9"]);
	await o.restart("#9", "try again");
	// The host dies during the body's publish call, which is not safe to repeat: after the
	// resume its outcome is unknown, and the orchestrator sees it (the log has it).
	for (let i = 0; i < 300 && !project.count().includes("publish"); i++) await new Promise((r) => setTimeout(r, 100));
	await o.kill();
	items = await o.wait();
	assert.deepEqual(items.map(label), ["stopped:"]);
	await o.resume();
	items = await o.wait();
	assert.deepEqual(items.map(label), ["outcome_unknown:#10"]);
	assert.equal(items[0]!.tool, "custom:./tools/lib.ts#publish");
	await o.restart("#10");
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
			uploaded: "https://example.test/sheet.jpg",
			picked: "a",
			confirmed: "cancelled",
			flaky: "served",
			fragile: "recovered",
			published: "note-6",
			last: "done",
		},
	});
	// The outside world: one search, the upload and the publish (each retried by its restart). Resumes replayed the journal.
	assert.deepEqual(project.count(), ["search", "upload", "upload", "publish", "publish"]);
	// Preflight warnings, in run metadata: the upload tool may write outside; the fx server keeps only read-only tools.
	const meta = readMeta(runPaths(runDir(project.root, o.id())))! as { warnings: string[] };
	assert.ok(meta.warnings.some((w) => /agent poster: tool upload may write outside \(unannotated\)/.test(w)), meta.warnings.join("\n"));
	assert.ok(meta.warnings.some((w) => /agent worker: from MCP server fx only tools annotated readOnlyHint are given; excluded: echo, other, wipe, post/.test(w)), meta.warnings.join("\n"));
}

test("acceptance through the CLI: every attention kind, entered and resolved", { timeout: 300_000 }, async () => {
	const project = acceptProject();
	const w = (...args: string[]) => wallis(project.root, args, project.env);
	let id = "";
	const ok = (r: ReturnType<typeof wallis>) => {
		assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
		return r.stdout;
	};
	const status = (run = id) => JSON.parse(ok(w("status", run, "--json"))) as { attention: Item[]; nodes: { id: string; type: string }[]; status: { outcome?: { type: string; value?: Record<string, unknown> } } };
	const o: Orchestrator = {
		id: () => id,
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
		restart: async (node, note) => void ok(w("restart", id, node, ...(note ? [note] : []))),
		cancelNode: async (node) => void ok(w("cancel", id, "--node", node)),
		kill: async () => killHost(project.root, id),
		outcome: async () => status().status.outcome!,
		midway: async () => {
			// A fork has what the log names (the idle call's checkpoint), not the source's live work dirs.
			const forked = ok(w("fork", id));
			const forkId = /into (\S+)\./.exec(forked)![1]!;
			const forkDir = runDir(project.root, forkId);
			const checkpoints = lines(join(forkDir, "log.jsonl")).filter((e) => e.type === "agent_progressed" && e.id === "#2");
			assert.ok(checkpoints.length > 0 && existsSync(blobPath(forkDir, String(checkpoints.at(-1)!.dialogue))), "the idle call's checkpoint is in the fork");
			// The source's idle call keeps its work dir; the fork (which does not reissue it) has none.
			assert.ok(existsSync(join(runDir(project.root, id), "work", "_2")));
			assert.ok(!existsSync(join(forkDir, "work", "_2")), "the fork copies no work dirs");
			assert.deepEqual(status(forkId).attention.map(label), ["ended_without_result:#2"]);
			ok(w("cancel", forkId));
		},
	};
	await scenario(o, project);
	// A fork of the finished run re-executes against the copied journal: nothing outside is called again.
	ok(w("fork", id));
	assert.deepEqual(project.count(), ["search", "upload", "upload", "publish", "publish"]);
});

test("acceptance through MCP: every attention kind, entered and resolved", { timeout: 300_000 }, async () => {
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
		id: () => id,
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
			const r = await call("restart", { run_id: id, node_id: node, ...(note ? { note } : {}) });
			assert.equal(r.isError, false, r.text);
		},
		cancelNode: async (node) => {
			const r = await call("cancel", { run_id: id, node_id: node });
			assert.equal(r.isError, false, r.text);
		},
		kill: async () => {
			// The server is the host.
			killHost(project.root, id);
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
