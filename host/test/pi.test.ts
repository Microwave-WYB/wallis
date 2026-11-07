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
	const provider = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-small", contextWindow: 2000 }] });
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
		declaration: {
			model: "default",
			prompt: "Answer.",
			input: {},
			output: {},
			mcp: {},
			tools: [],
			skills: [],
			needs: {},
			sandbox: "none",
			mounts: [],
			steerable: true,
			compaction: true,
			max_turns: 6,
		},
		model: "faux/faux-1",
		prompt: 'Input:\n{ "question": "how many?" }',
		input: { question: "how many?" },
		note: null,
		contextTokens: undefined,
		maxTurns: 6,
		digest: "d",
		transcript: [],
		outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "integer", minimum: 1 } } },
		workspace: { level: "none", root: "/nonexistent", inputs: "/nonexistent", scratch: null, mounts: {}, spill: join(tmp(), "spill") },
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
	const node = first.run.nodes[0]!;
	assert.equal(node.type === "node_idle" && node.question, "Who is the audience?");
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

test("pi codemode: every agent gets codemode; its script reads the full input (folded in the prompt) and submits through the tool layer", async () => {
	const { provider, executor } = faux();
	const prompts: string[] = [];
	provider.setResponses([
		(ctx) => {
			prompts.push(JSON.stringify(ctx.messages));
			return call("codemode", { code: "await tools.submit_result({ summary: `${input.topic}: ${input.notes.length} notes, last ${input.notes.at(-1)}` }); return 'done';" });
		},
	]);
	const dir = join(tmp(), "run");
	const notes = Array.from({ length: 30 }, (_, i) => `note number ${i}`);
	const r = await runWorkflow({ workflow: resolve(here, "fixtures/pi/workflow.ts"), dir, executor, input: { topic: "x", notes }, inboxPollMs: null });
	assert.deepEqual(r.outcome, { type: "done", value: { summary: "x: 30 notes, last note number 29" } });
	// The prompt shows a skeleton of the folded field, and says so.
	assert.match(prompts[0]!, /folded.*array.*items.*30/);
	assert.match(prompts[0]!, /Folded fields.*\/notes/);
	assert.doesNotMatch(prompts[0]!, /note number 29/);
	const transcript = readFileSync(join(dir, "nodes", "_0.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	const calls = transcript.filter((e) => e.kind === "tool_call").map((e) => [e.tool, e.nested]);
	assert.deepEqual(calls, [["codemode", false], ["submit_result", true]]);
	assert.ok(!existsSync(join(dir, "work", "_0")), "the node's dir is gone");
});

test("pi: a dialogue over the window is compacted (logged); with compaction off it fails as context_exhausted", async () => {
	const long = "x".repeat(6000);
	const run = async (compaction: boolean) => {
		const { provider, executor } = faux();
		const seen: string[] = [];
		provider.setResponses([
			call("read_spill", { name: "none" }),
			fauxAssistantMessage(long),
			() => {
				seen.push("summary request");
				return fauxAssistantMessage("Earlier: the agent tried a spill read and talked at length.");
			},
			(ctx) => {
				seen.push(JSON.stringify(ctx.messages).length < 5000 ? "compacted" : "full");
				return call("submit_result", { answer: 3 });
			},
		]);
		const s = spec({ model: "faux/faux-small", declaration: { ...spec().declaration, compaction } });
		const session = await executor.start(s);
		const first = await session.turn();
		const second = first.type === "ended" ? await session.turn("go on") : first;
		await session.close();
		return { first, second, seen, notes: s.entries.filter((e) => e.kind === "note").map((e) => (e as { text: string }).text) };
	};
	const on = await run(true);
	assert.equal(on.first.type, "ended");
	assert.equal(on.second.type, "submitted", JSON.stringify(on.second));
	assert.deepEqual(on.seen, ["summary request", "compacted"]);
	assert.ok(on.notes.some((n) => /^compacted \d+ messages/.test(n)));
	const off = await run(false);
	assert.deepEqual(off.second.type === "agent_error" && off.second.failure, { type: "context_exhausted" });
	assert.ok(off.notes.some((n) => n.startsWith("context exhausted")));
});

test("the tool layer caps results: the overflow is spilled with a marker and paged by read_spill", async () => {
	const s = spec();
	const tools = await buildNodeTools(s, { resultCap: 100 });
	tools.add({ name: "big", description: "returns a lot", parameters: { type: "object" }, run: async () => ({ text: "y".repeat(250) }) });
	const direct = tools.agentTools().find((t) => t.name === "big")!;
	const out = await direct.execute("1", {}, undefined as never, undefined as never);
	const text = (out.content[0] as { text: string }).text;
	assert.match(text, /^y{100}\n\[output truncated at 100 of 250 chars; the full text is spill "1.txt"\. Page it from the next script: await tools.read_spill\(\{ name: "1.txt", offset: 100 \}\)\]$/);
	const page = await tools.invoke("read_spill", { name: "1.txt", offset: 100 }, true);
	assert.deepEqual(page.value, { text: "y".repeat(150), next: 250, total: 250 });
	assert.ok(s.entries.some((e) => e.kind === "note" && /spilled 250 chars/.test((e as { text: string }).text)));
	// A submitted result over the output cap goes back as a validation error.
	const huge = await tools.invoke("submit_result", { answer: 1, pad: "z".repeat(200_000) }, false);
	assert.equal(huge.isError, true);
	assert.match(huge.text, /the cap is 100000/);
});

test("pi: a provider error is an executor error: the run pauses, a resume reissues the call", async () => {
	const { provider, executor } = faux();
	provider.setResponses([fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "HTTP 412 account suspended" })]);
	const dir = join(tmp(), "run");
	const workflow = resolve(here, "fixtures/pi/workflow.ts");
	const paused = await runWorkflow({ workflow, dir, executor, input: { topic: "x", notes: [] }, inboxPollMs: null });
	assert.deepEqual(paused.status, { type: "idle", reason: { type: "executor_unavailable", alias: "default", error: "HTTP 412 account suspended" } });
	provider.setResponses([call("submit_result", { summary: "fine now" })]);
	const resumed = await runWorkflow({ workflow, dir, executor, inboxPollMs: null });
	assert.deepEqual(resumed.outcome, { type: "done", value: { summary: "fine now" } });
});

test("the tool layer: every tool is offered directly and through codemode; disallowed names are refused and logged", async () => {
	const dir = tmp();
	const s = spec({ workspace: { level: "read-only", root: dir, inputs: dir, scratch: null, mounts: {}, spill: join(dir, "spill") } });
	const tools = await buildNodeTools(s);
	assert.deepEqual(tools.agentTools().map((t) => t.name).sort(), ["codemode", "list_dir", "read_file", "read_spill", "submit_result"]);
	const refused = await tools.invoke("exec", { command: "id" }, true);
	assert.equal(refused.isError, true);
	assert.match(refused.text, /not allowed/);
	assert.ok(s.entries.some((e) => e.kind === "tool_call" && e.tool === "exec"));
	// A sandbox "none" agent gets codemode too, and no fs tools.
	const none = await buildNodeTools(spec());
	assert.deepEqual(none.agentTools().map((t) => t.name).sort(), ["codemode", "read_spill", "submit_result"]);
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
