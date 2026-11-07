// The pi executor on pi-ai's faux provider: no real model calls.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { NodeSpec, TranscriptEntry } from "../src/host/executor.ts";
import { runWorkflow } from "../src/host/index.ts";
import { parseModel, PiExecutor } from "../src/host/pi.ts";
import { buildNodeTools } from "../src/host/tools.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

function faux() {
	const provider = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
	const models = createModels();
	models.setProvider(provider.provider);
	return { provider, executor: new PiExecutor({ models }) };
}

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

function spec(overrides: Partial<NodeSpec> = {}): NodeSpec & { entries: TranscriptEntry[] } {
	const entries: TranscriptEntry[] = [];
	return {
		id: "#0",
		agent: "answerer",
		declaration: { model: "default", prompt: "Answer.", input: {}, output: {}, writes: {}, mcp: {}, tools: [], skills: [], needs: {}, sandbox: "none", data: [], codemode: true, max_turns: 6 } as never,
		model: "faux/faux-1",
		view: '<field name="note">\n"hello"\n</field>',
		omitted: {},
		input: { question: "how many?" },
		maxTurns: 6,
		digest: "d",
		transcript: [],
		outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "integer", minimum: 1 } } },
		workspace: { level: "none", root: "/nonexistent", inputs: "/nonexistent", scratch: null, data: {} },
		exportArtifact: () => {
			throw new Error("no scratch");
		},
		mcp: null,
		log: (e) => entries.push(e),
		...overrides,
		entries,
	};
}

test("model strings parse into provider, id and an optional thinking level", () => {
	assert.deepEqual(parseModel("openai/gpt-5:medium"), { provider: "openai", id: "gpt-5", thinking: "medium" });
	assert.deepEqual(parseModel("openrouter/qwen/qwen3-coder:exacto"), { provider: "openrouter", id: "qwen/qwen3-coder:exacto", thinking: undefined });
});

test("pi: a turn ends with a question; rebind; the reply continues; an invalid submit_result goes back to the model", async () => {
	const { provider, executor } = faux();
	const seen: string[] = [];
	let lastSeen: unknown;
	provider.setResponses([
		(_ctx, _o, _s, model) => {
			seen.push(model.id);
			return fauxAssistantMessage("Do you mean apples or pears?");
		},
		(_ctx, _o, _s, model) => {
			seen.push(model.id);
			return call("submit_result", { answer: 0 });
		},
		(ctx, _o, _s, model) => {
			seen.push(model.id);
			lastSeen = ctx.messages.filter((m) => (m as { role: string }).role !== "system").at(-1);
			return call("submit_result", { answer: 2 });
		},
	]);
	const s = spec();
	const session = await executor.start(s);
	const first = await session.turn();
	assert.equal(first.type, "ended");
	assert.equal((first as { message: string }).message, "Do you mean apples or pears?");
	session.rebind!("faux/faux-2");
	const result = await session.turn("apples");
	const last = lastSeen as { role: string; content: { text?: string }[]; isError?: boolean };
	assert.equal(last.role, "toolResult");
	assert.equal(last.isError, true);
	// pi checks tool arguments against the schema first; wallis's own check is the second line.
	assert.match(last.content[0]!.text!, /answer: expected >= 1/);
	assert.equal(result.type, "submitted", JSON.stringify(result));
	assert.deepEqual((result as { output: unknown }).output, { answer: 2 });
	assert.equal((result as { usage: { turns: number } }).usage.turns, 2);
	assert.deepEqual(seen, ["faux-1", "faux-2", "faux-2"]);
	// The accepted submission went through the wallis tool layer and its log.
	assert.deepEqual(
		s.entries.filter((e) => e.kind === "tool_result").map((e) => (e as { tool: string; isError: boolean }).isError),
		[false],
	);
	assert.ok(s.entries.some((e) => e.kind === "assistant" && e.text === "Do you mean apples or pears?"));
	await session.close();
});

const ask = resolve(here, "../examples/ask/workflow.ts");

test("pi in a workflow: the scout asks, the reply continues it, the run finishes; transcripts are written", async () => {
	const { provider, executor } = faux();
	const prompts: string[] = [];
	provider.setResponses([
		fauxAssistantMessage("Who is the audience?"),
		(ctx) => {
			prompts.push(JSON.stringify(ctx.messages));
			return call("submit_result", { outline: ["what", "why"], note: "for newcomers" });
		},
		call("submit_result", { text: "What. Why.", words: 2 }),
	]);
	const dir = join(tmp(), "run");
	const opts = { workflow: ask, dir, executor, models: { default: "faux/faux-1" }, inboxPollMs: null } as const;
	const first = await runWorkflow({ ...opts, input: { topic: "folds" } });
	assert.deepEqual(first.run.nodes[0]!.status, { type: "node_idle", last_message: "Who is the audience?" });
	const done = await runWorkflow({ workflow: ask, dir, executor, inboxPollMs: null, sends: [{ node: "#0", text: "newcomers" }] });
	assert.equal(done.outcome?.type, "done", JSON.stringify(done.status));
	// The rebuilt session carried the conversation so far.
	assert.match(prompts[0]!, /Conversation so far:.*Who is the audience\?/);
	assert.match(prompts[0]!, /The human: newcomers/);
	const transcript = readFileSync(join(dir, "nodes", "_0.jsonl"), "utf8");
	assert.match(transcript, /"kind":"assistant","text":"Who is the audience\?"/);
	assert.match(transcript, /"kind":"user","text":"newcomers"/);
	assert.match(transcript, /"kind":"tool_call","tool":"submit_result"/);
});

test("pi codemode: an agent with tools gets codemode; its script calls state_read and submit_result through the tool layer", async () => {
	const { provider, executor } = faux();
	provider.setResponses([
		() => {
			return call("codemode", {
				code: "const view = await tools.state_read({}); await tools.submit_result({ summary: view.includes('state note') ? 'saw the note' : 'missed' }); return 'done';",
			});
		},
	]);
	const dir = join(tmp(), "run");
	const r = await runWorkflow({ workflow: resolve(here, "fixtures/pi/workflow.ts"), dir, executor, input: { topic: "x" }, inboxPollMs: null });
	assert.deepEqual(r.outcome, { type: "done", value: { summary: "saw the note" } });
	const transcript = readFileSync(join(dir, "nodes", "_0.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	const calls = transcript.filter((e) => e.kind === "tool_call").map((e) => [e.tool, e.nested]);
	assert.deepEqual(calls, [["codemode", false], ["state_read", true], ["submit_result", true]]);
	assert.ok(!existsSync(join(dir, "work")) || !existsSync(join(dir, "work", "_0")), "the node's dir is gone");
});

test("pi: a provider error is an executor error: the run pauses, a resume reissues the call", async () => {
	const { provider, executor } = faux();
	provider.setResponses([fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "HTTP 412 account suspended" })]);
	const dir = join(tmp(), "run");
	const workflow = resolve(here, "fixtures/pi/workflow.ts");
	const paused = await runWorkflow({ workflow, dir, executor, input: { topic: "x" }, inboxPollMs: null });
	assert.deepEqual(paused.status, { type: "idle", reason: { type: "executor_unavailable", alias: "default", error: "HTTP 412 account suspended" } });
	provider.setResponses([call("submit_result", { summary: "fine now" })]);
	const resumed = await runWorkflow({ workflow, dir, executor, inboxPollMs: null });
	assert.deepEqual(resumed.outcome, { type: "done", value: { summary: "fine now" } });
});

test("the tool layer: codemode wraps an agent's tools; disallowed names are refused and logged", async () => {
	const dir = tmp();
	const s = spec({ workspace: { level: "read-only", root: dir, inputs: dir, scratch: null, data: {} } });
	const tools = await buildNodeTools(s);
	assert.deepEqual(tools.agentTools().map((t) => t.name), ["submit_result", "codemode"]);
	assert.deepEqual(tools.names.sort(), ["codemode", "list_dir", "read_file", "state_read", "submit_result"]);
	const refused = await tools.invoke("exec", { command: "id" }, true);
	assert.equal(refused.isError, true);
	assert.match(refused.text, /not allowed/);
	assert.ok(s.entries.some((e) => e.kind === "tool_call" && e.tool === "exec"));
	const off = await buildNodeTools(spec({ declaration: { ...(spec().declaration as object), codemode: false } as never, workspace: { level: "read-only", root: dir, inputs: dir, scratch: null, data: {} } }));
	assert.deepEqual(off.agentTools().map((t) => t.name).sort(), ["list_dir", "read_file", "state_read", "submit_result"]);
});

test("upstream MCP through pi-mcp: only allowlisted tools, secrets only in the server process", async () => {
	const server = resolve(here, "fixtures/mcp-server.ts");
	const s = spec({
		declaration: { ...(spec().declaration as object), mcp: { fx: ["echo"] } } as never,
		mcp: { fx: { command: process.execPath, args: [server], env: { TOKEN: "${TOKEN}", PATH: process.env.PATH ?? "" } } },
	});
	const tools = await buildNodeTools(s, { secrets: { TOKEN: "s3cret" } });
	try {
		assert.ok(tools.names.includes("mcp__fx__echo"));
		assert.ok(!tools.names.includes("mcp__fx__other"));
		const r = await tools.invoke("mcp__fx__echo", { text: "hi" }, false);
		assert.equal(r.text, "hi; token=present");
		assert.ok(!JSON.stringify(s.entries).includes("s3cret"), "the secret never reaches the transcript");
		assert.ok(!JSON.stringify(s).includes("s3cret"), "nor the node spec");
	} finally {
		await tools.close();
	}
});
