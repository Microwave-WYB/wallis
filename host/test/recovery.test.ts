// Recovery, the most important property: transient executor errors retry
// inside the executor (R1), a node continues from its last completed turn
// after a crash (R2), an uncaught node failure holds only its dependents and
// is restartable (R3). Also the turn quota and turn limit, and the MCP
// containment check. pi runs on pi-ai's faux provider only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { NodeSpec, TranscriptEntry } from "../src/host/executor.ts";
import { appendInbox, EventLog, FakeCommands, FakeExecutor, PiExecutor, runPaths, runWorkflow, startSession } from "../src/host/index.ts";
import { writesOutside } from "../src/host/toolsets.ts";
import { transientError } from "../src/host/pi.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const piWorkflow = resolve(here, "fixtures/pi/workflow.ts");
const fanout = resolve(here, "fixtures/fanout/workflow.ts");

function faux(retryDelaysMs = [1, 1, 1]) {
	const provider = fauxProvider({ models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(provider.provider);
	return { provider, executor: new PiExecutor({ models, retryDelaysMs }) };
}

const codemode = (code: string) => fauxAssistantMessage([fauxToolCall("codemode", { code } as never)], { stopReason: "toolUse" });
const submit = (args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall("submit_result", args as never)], { stopReason: "toolUse" });
const failure = (message: string) => fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: message });

function transcript(dir: string, node = "_0_0"): TranscriptEntry[] {
	return readFileSync(join(dir, "nodes", `${node}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
}
const notes = (entries: TranscriptEntry[]) => entries.filter((e) => e.kind === "note").map((e) => (e as { text: string }).text);

// --- R1 ---

test("R1: transient provider errors are retried inside the executor (logged); the run never sees them", async () => {
	const { provider, executor } = faux();
	provider.setResponses([failure("429 Too Many Requests"), failure("529 overloaded"), submit({ summary: "after retries" })]);
	const dir = join(tmp(), "run");
	const r = await runWorkflow({ workflow: piWorkflow, dir, executor, confine: "off", input: { topic: "t", notes: [] }, inboxPollMs: null });
	assert.deepEqual(r.outcome, { type: "done", value: { summary: "after retries" } });
	assert.ok(!new EventLog(join(dir, "log.jsonl")).read().some((e) => e.type === "executor_failed"));
	const retried = notes(transcript(dir)).filter((n) => n.startsWith("transient executor error"));
	assert.equal(retried.length, 2);
	assert.match(retried[0]!, /429 Too Many Requests\); retry 1 of 3/);
});

test("R1: non-transient errors (auth, billing, a missing model) are not retried; exhausted retries pause the run", async () => {
	assert.equal(transientError("HTTP 412 account suspended"), false);
	assert.equal(transientError("401 invalid api key"), false);
	assert.equal(transientError("model not found"), false);
	assert.equal(transientError("fetch failed: ECONNRESET"), true);
	assert.equal(transientError("503 Service Unavailable"), true);
	const { provider, executor } = faux();
	provider.setResponses([failure("HTTP 412 account suspended")]);
	const dir = join(tmp(), "run");
	const paused = await runWorkflow({ workflow: piWorkflow, dir, executor, confine: "off", input: { topic: "t", notes: [] }, inboxPollMs: null });
	assert.deepEqual(paused.status, { type: "idle", reason: { type: "executor_unavailable", alias: "default", error: "HTTP 412 account suspended" } });
	assert.equal(provider.state.callCount, 1, "no retry");
	const again = faux();
	again.provider.setResponses([failure("500"), failure("500"), failure("500"), failure("500")]);
	const dir2 = join(tmp(), "run");
	const exhausted = await runWorkflow({ workflow: piWorkflow, dir: dir2, executor: again.executor, confine: "off", input: { topic: "t", notes: [] }, inboxPollMs: null });
	assert.equal(exhausted.status.type, "idle");
	assert.equal(again.provider.state.callCount, 4, "1 attempt + 3 retries");
});

// --- R2 ---

test("R2: SIGKILL at turn 3; the resumed node continues at turn 3 and turns 1-2 are not requested again", async () => {
	const dir = join(tmp(), "run");
	const killed = spawnSync(process.execPath, [resolve(here, "fixtures/crash/drive.ts"), dir, "3"], { encoding: "utf8", timeout: 60_000 });
	assert.equal(killed.signal, "SIGKILL", killed.stderr);
	const checkpoint = JSON.parse(readFileSync(join(dir, "work", "_0_0", "session.json"), "utf8")) as { turns: number };
	assert.equal(checkpoint.turns, 2);
	const { provider, executor } = faux();
	const requests: string[] = [];
	provider.setResponses([
		(ctx) => {
			requests.push(JSON.stringify(ctx.messages));
			return submit({ summary: "resumed" });
		},
	]);
	const r = await runWorkflow({ workflow: piWorkflow, dir, executor, confine: "off", inboxPollMs: null });
	assert.deepEqual(r.outcome, { type: "done", value: { summary: "resumed" } });
	assert.equal(requests.length, 1, "only turn 3 was requested");
	// The restored conversation holds turns 1 and 2: their codemode calls and results.
	assert.match(requests[0]!, /return 1;/);
	assert.match(requests[0]!, /return 2;/);
	assert.match(requests[0]!, /\[Turn 3 of 16\]/);
	assert.ok(notes(transcript(dir)).some((n) => n.startsWith("resumed from its checkpoint after turn 2")));
});

test("R2: a tool call in flight at a crash is re-run if it only reads, else becomes an error the model sees", async () => {
	const { provider, executor } = faux();
	const dir = tmp();
	const entries: TranscriptEntry[] = [];
	const checkpoint = join(dir, "session.json");
	const call = (name: string, args: Record<string, unknown>, id: string) => ({ type: "toolCall", id, name, arguments: args });
	// A checkpoint that ends with an assistant turn whose tools never returned.
	const messages = [
		{ role: "user", content: "Input", timestamp: 1 },
		{ role: "assistant", content: [call("read_spill", { name: "1.txt" }, "a"), call("bash", { command: "rm x" }, "b")], stopReason: "toolUse", timestamp: 2, api: "faux", provider: "faux", model: "faux-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
	];
	(await import("node:fs")).writeFileSync(checkpoint, JSON.stringify({ messages, turns: 1, compacted: null }));
	const seen: string[] = [];
	provider.setResponses([
		(ctx) => {
			seen.push(JSON.stringify(ctx.messages));
			return submit({ answer: 1 });
		},
	]);
	const spec = {
		id: "#0:0",
		agent: "a",
		declaration: { model: "default", prompt: "p", input: {}, output: {}, tools: [], access: 3, skills: [], needs: {}, sandbox: null, steerable: true, compaction: true, max_turns: 6 },
		history: null,
		recorded: new Map(),
		retryUnknown: false,
		record: () => {},
		model: "faux/faux-1",
		prompt: "Input",
		input: null,
		note: null,
		contextTokens: undefined,
		turn: 1,
		turnLimit: 6,
		checkpoint,
		digest: "d",
		transcript: [],
		outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "integer" } } },
		workspace: { root: dir, inputs: dir, scratch: dir, mounts: {}, spill: join(dir, "spill") },
		sandbox: { type: "none" },
		exportArtifact: () => {
			throw new Error("no");
		},
		connect: () => Promise.reject(new Error("no tool sources")),
		warn: () => {},
		log: (e: TranscriptEntry) => entries.push(e),
	} as unknown as NodeSpec;
	const session = await executor.start(spec);
	const r = await session.turn();
	assert.equal(r.type, "submitted");
	assert.match(seen[0]!, /read_spill/);
	assert.match(seen[0]!, /The host stopped while bash was running; it may or may not have taken effect/);
	assert.ok(notes(entries).includes("re-ran read_spill after a crash"));
	await session.close();
});

// --- The turn quota and the turn limit ---

test("every turn shows its quota at the end of the newest message; the prefix stays stable", async () => {
	const { provider, executor } = faux();
	const requests: unknown[][] = [];
	const capture = (reply: ReturnType<typeof codemode>) => (ctx: { messages: unknown[] }) => {
		requests.push(JSON.parse(JSON.stringify(ctx.messages)));
		return reply;
	};
	provider.setResponses([capture(codemode("return 1;")), capture(codemode("return 2;")), capture(submit({ summary: "s" }))]);
	const dir = join(tmp(), "run");
	await runWorkflow({ workflow: piWorkflow, dir, executor, confine: "off", input: { topic: "t", notes: [] }, inboxPollMs: null });
	assert.equal(requests.length, 3);
	for (const [k, messages] of requests.entries()) {
		assert.match(JSON.stringify(messages.at(-1)), new RegExp(`\\[Turn ${k + 1} of 16\\]`));
		// Each request extends the previous one unchanged: the cached prefix is stable.
		if (k > 0) assert.deepEqual(messages.slice(0, requests[k - 1]!.length), requests[k - 1]);
		assert.doesNotMatch(JSON.stringify(messages[0]), /Turn \d+ of/, "never in the system prompt");
	}
});

test("pi: reaching the turn limit stops the node (turn_limit) with its progress; more turns continue it", async () => {
	const { provider, executor } = faux();
	provider.setResponses([codemode("return 1;"), codemode("return 2;"), submit({ summary: "done" })]);
	const dir = join(tmp(), "run");
	const workflow = resolve(here, "fixtures/pi/workflow.ts");
	const { writeFileSync } = await import("node:fs");
	const limited = join(tmp(), "workflow.ts");
	writeFileSync(limited, readFileSync(workflow, "utf8").replace('workspace: { access: "exec", sandbox: shell },', 'workspace: { access: "exec", sandbox: shell },\n\t\tmaxTurns: 2,'));
	const first = await runWorkflow({ workflow: limited, dir, executor, confine: "off", input: { topic: "t", notes: [] }, inboxPollMs: null });
	const node = first.run.nodes[0]!;
	assert.deepEqual(node.type === "node_idle" && node.cause, { type: "turn_limit", used: 2, limit: 2 });
	const done = await runWorkflow({ workflow: limited, dir, executor, confine: "off", sends: [{ node: "#0:0", text: "Continue.", turns: 2 }], inboxPollMs: null });
	assert.deepEqual(done.outcome, { type: "done", value: { summary: "done" } });
	assert.equal(provider.state.callCount, 3, "nothing requested twice");
});

// --- R3 ---

function failingScout() {
	return new FakeExecutor({
		scout: (call) => ((call.input as { area: string }).area === "a" ? { giveUp: "could not read the area" } : { output: { errors: ["E-b"] } }),
		judge: { output: { findings: [] } },
		merger: { output: { items: [], archived: [] } },
		attempt: { output: { ok: true } },
	});
}

const fakeTrain = () => new FakeCommands({ train: { stdout: JSON.stringify({ budget: null }) } });

test("R3: an uncaught node failure holds the run on that node; the independent sibling completes", async () => {
	const dir = join(tmp(), "run");
	const executor = failingScout();
	const r = await runWorkflow({ workflow: fanout, dir, executor, commands: fakeTrain(), confine: "off", input: null, inboxPollMs: null });
	assert.equal(r.outcome, null, "not finished");
	assert.deepEqual(r.status, { type: "idle", reason: { type: "node_failure", node: "#0.a#0:0", reason: { type: "agent_gave_up", agent: "scout", failure: { type: "gave_up", error: "could not read the area" } } } });
	assert.equal(r.run.held, "#0.a#0:0");
	const sibling = r.run.nodes.find((n) => n.id === "#0.b#0:0")!;
	assert.equal(sibling.type === "node_done" && sibling.outcome.type, "submitted");
	const { attention, describe } = await import("../src/host/query.ts");
	const { inspectRun } = await import("../src/host/index.ts");
	assert.match(describe(attention(inspectRun(dir))), /node #0\.a#0:0 failed and the workflow did not handle it[\s\S]*npx wallis restart/);
});

test("R3: restart the held node: it reruns, the body runs again against the journal, and the run completes", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ workflow: fanout, dir, executor: failingScout(), commands: fakeTrain(), confine: "off", input: null, inboxPollMs: null });
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: "#0.a#0:0", note: "the area is fine now", by: "human" });
	const fixed = new FakeExecutor({
		scout: { output: { errors: ["E-a"] } },
		judge: { output: { findings: [] } },
		merger: { output: { items: [], archived: [] } },
		attempt: { output: { ok: true } },
	});
	const done = await runWorkflow({ workflow: fanout, dir, executor: fixed, commands: fakeTrain(), confine: "off", inboxPollMs: null });
	assert.equal(done.outcome?.type, "done", JSON.stringify(done.status));
	assert.deepEqual((done.outcome as unknown as { value: { errors: string[] } }).value.errors, ["E-a", "E-b"]);
	// The restarted scout ran with its note; the completed sibling was not called again.
	const scouts = fixed.calls.filter((c) => c.agent === "scout");
	assert.deepEqual(scouts.map((c) => [c.id, c.note]), [["#0.a#0:0", "the area is fine now"]]);
	assert.ok(new EventLog(join(dir, "log.jsonl")).read().some((e) => e.type === "restarted"));
});

test("R3: cancel the held node: the failure propagates and the run finishes failed", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ workflow: fanout, dir, executor: failingScout(), commands: fakeTrain(), confine: "off", input: null, inboxPollMs: null });
	appendInbox(runPaths(dir), { id: "c1", type: "cancel_node", node: "#0.a#0:0", by: "human" });
	const r = await runWorkflow({ workflow: fanout, dir, executor: failingScout(), commands: fakeTrain(), confine: "off", inboxPollMs: null });
	assert.deepEqual(r.outcome, { type: "failed", reason: { type: "agent_gave_up", agent: "scout", failure: { type: "gave_up", error: "could not read the area" } } });
});

test("R3: a failed command is held the same way and a restart reruns it", async () => {
	const dir = join(tmp(), "run");
	const good = () =>
		new FakeExecutor({
			scout: { output: { errors: [] } },
			judge: { output: { findings: [] } },
			merger: { output: { items: [], archived: [] } },
			attempt: { output: { ok: true } },
		});
	const broken = new FakeCommands({ train: { exit: 127, stderr: "uv: not found" } });
	const r = await runWorkflow({ workflow: fanout, dir, executor: good(), commands: broken, confine: "off", input: null, inboxPollMs: null });
	assert.equal(r.status.type === "idle" && r.status.reason?.type, "node_failure");
	const held = r.run.held!;
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: held, by: "human" });
	const fixed = fakeTrain();
	const done = await runWorkflow({ workflow: fanout, dir, executor: good(), commands: fixed, confine: "off", inboxPollMs: null });
	assert.equal(done.outcome?.type, "done", JSON.stringify(done.status));
	assert.equal(fixed.calls[0]!.id, held);
});

// --- The write rule ---

test("the write rule: a tool may write outside unless annotated read-only, or neither destructive nor open-world; unannotated counts as a write", () => {
	assert.equal(writesOutside({}), true);
	assert.equal(writesOutside({ readOnlyHint: true }), false);
	assert.equal(writesOutside({ readOnlyHint: false, destructiveHint: false, openWorldHint: false }), false);
	assert.equal(writesOutside({ readOnlyHint: false, destructiveHint: false }), true);
	assert.equal(writesOutside({ destructiveHint: true }), true);
});

test("a body tool call still in flight when the body runs again (a held node's restart) is not called twice", async () => {
	const { mkdirSync, readFileSync: read, existsSync } = await import("node:fs");
	const dir = tmp();
	const count = join(dir, "count.txt");
	mkdirSync(join(dir, "wf"));
	writeFileSync(
		join(dir, "wf", "mcp.json"),
		JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [resolve(here, "fixtures/mcp-server.ts")], env: { COUNT_FILE: "${COUNT_FILE}" } } } }),
	);
	writeFileSync(
		join(dir, "wf", "workflow.ts"),
		`import { defineAgent, defineMcp, defineModels, Type, workflow } from "wallis";
import m from "./mcp.json" with { type: "json" };
const models = defineModels({ default: "fake/default" });
const fx = defineMcp(m);
const flaky = defineAgent({ models }, { name: "flaky", model: "default", prompt: "p", input: Type.Null(), output: Type.Object({ ok: Type.Boolean() }) });
export default workflow({ name: "inflight", models, mcp: fx, agents: [flaky], input: Type.Null(), output: Type.Any(),
	run: async (ctx) => ctx.parallel({ slow: (c) => c.call(fx.fx.slow, {}), flaky: (c) => c.session(flaky).call(null) }) });
`,
	);
	let calls = 0;
	const executor = new FakeExecutor({ flaky: () => (calls++ === 0 ? { giveUp: "first time" } : { submit: { ok: true } }) });
	process.env.COUNT_FILE = count;
	try {
		const run = join(dir, "run");
		const session = await startSession({ workflow: join(dir, "wf", "workflow.ts"), dir: run, executor, confine: "off", input: null, inboxPollMs: 20 });
		// The flaky branch fails and the run is held on it while the slow tool call is still in flight.
		for (let i = 0; i < 100 && session.snapshot().held === null; i++) await new Promise((r) => setTimeout(r, 20));
		assert.equal(session.snapshot().held, "#0.flaky#0:0");
		// The server has the call before the body runs again.
		for (let i = 0; i < 100 && !existsSync(count); i++) await new Promise((r) => setTimeout(r, 20));
		appendInbox(runPaths(run), { id: "r1", type: "restart", node: "#0.flaky#0:0", by: "human" });
		const done = await session.result;
		assert.deepEqual(done.outcome, { type: "done", value: { slow: { done: true }, flaky: { ok: true } } });
		assert.deepEqual(existsSync(count) ? read(count, "utf8").trim().split("\n") : [], ["slow"], "the outside world saw the call once");
		const transcript = read(join(run, "nodes", "_0.slow_0.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string });
		assert.equal(transcript.filter((e) => e.kind === "tool_call").length, 1, "issued once");
	} finally {
		delete process.env.COUNT_FILE;
	}
});
