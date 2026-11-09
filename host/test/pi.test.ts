// The pi executor on pi-ai's faux provider: no real model calls.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { NodeSpec, TranscriptEntry } from "../src/host/executor.ts";
import { runWorkflow } from "../src/host/index.ts";
import { parseModel, PiExecutor } from "../src/host/pi.ts";
import { buildNodeTools } from "../src/host/tools.ts";
import { ToolSources } from "../src/host/toolsets.ts";
import type { Json, ToolDesc } from "../src/sdk/index.ts";
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
		id: "#0:0",
		agent: "answerer",
		declaration: {
			model: "default",
			prompt: "Answer.",
			input: {},
			output: {},
			tools: [],
			access: 0,
			skills: [],
			needs: {},
			sandbox: null,
			steerable: true,
			compaction: true,
			max_turns: 6,
		},
		model: "faux/faux-1",
		prompt: 'Input:\n{ "question": "how many?" }',
		input: { question: "how many?" },
		note: null,
		contextTokens: undefined,
		turn: 0,
		turnLimit: 6,
		digest: "d",
		transcript: [],
		history: null,
		recorded: new Map(),
		record: () => {},
		outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "integer", minimum: 1 } } },
		workspace: { root: "/nonexistent", inputs: "/nonexistent", scratch: "/nonexistent", mounts: {}, spill: join(tmp(), "spill") },
		sandbox: { type: "none" },
		checkpoint: join(tmp(), "session.json"),
		exportArtifact: () => {
			throw new Error("no scratch");
		},
		connect: () => Promise.reject(new Error("no tool sources")),
		warn: (text) => entries.push({ kind: "note", text: `warning: ${text}` }),
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
		call("ask", { message: "Who is the audience?" }),
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
	assert.equal(node.type === "node_idle" && node.cause.type === "question" && node.cause.message, "Who is the audience?");
	const done = await runWorkflow({ workflow: ask, dir, executor, inboxPollMs: null, sends: [{ node: "#0:0", text: "newcomers" }] });
	assert.equal(done.outcome?.type, "done", JSON.stringify(done.status));
	// The new session resumed from the node's checkpoint: the reply is the ask's result, with the quota on it.
	assert.match(prompts[0]!, /"toolName":"ask","content":\[\{"type":"text","text":"newcomers\\n\\n\[Turn 2 of 16\]/);
	const transcript = readFileSync(join(dir, "nodes", "_0_0.jsonl"), "utf8");
	assert.match(transcript, /"kind":"tool_call","tool":"ask","args":\{"message":"Who is the audience\?"\}/);
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
	const transcript = readFileSync(join(dir, "nodes", "_0_0.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	const calls = transcript.filter((e) => e.kind === "tool_call").map((e) => [e.tool, e.nested]);
	assert.deepEqual(calls, [["codemode", false], ["submit_result", true]]);
	assert.ok(!existsSync(join(dir, "work", "_0_0")), "the node's dir is gone");
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
	const page = await tools.invoke("read_spill", { name: "1.txt", offset: 100 }, true, undefined, "t1");
	assert.deepEqual(page.value, { text: "y".repeat(150), next: 250, total: 250 });
	assert.ok(s.entries.some((e) => e.kind === "note" && /spilled 250 chars/.test((e as { text: string }).text)));
	// A submitted result over the output cap goes back as a validation error.
	const huge = await tools.invoke("submit_result", { answer: 1, pad: "z".repeat(200_000) }, false, undefined, "t1");
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

test("the tool layer: workspace access gives pi's file tools on the sandbox's paths; unknown names are refused and logged", async () => {
	const dir = tmp();
	const mount = tmp();
	writeFileSync(join(mount, "notes.txt"), "from the mount\nline 2");
	writeFileSync(join(mount, "dot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
	const ws = { root: dir, inputs: join(dir, "inputs"), scratch: join(dir, "scratch"), mounts: { data: mount }, spill: join(dir, "spill") };
	mkdirSync(join(dir, "scratch"), { recursive: true });
	const at = (access: 0 | 1 | 2 | 3) => spec({ declaration: { ...spec().declaration, access }, workspace: ws, sandbox: { type: "unavailable", name: "shell", reason: "test" } });
	const names = async (access: 0 | 1 | 2 | 3) => (await buildNodeTools(at(access))).agentTools().map((t) => t.name).sort();
	assert.deepEqual(await names(0), ["codemode", "read_spill", "submit_result"]);
	assert.deepEqual(await names(1), ["codemode", "ls", "read", "read_spill", "submit_result"]);
	assert.deepEqual(await names(2), ["codemode", "edit", "export_artifact", "ls", "read", "read_spill", "submit_result", "write"]);
	assert.deepEqual(await names(3), ["bash", "codemode", "edit", "export_artifact", "ls", "read", "read_spill", "submit_result", "write"]);
	const s = at(3);
	const tools = await buildNodeTools(s);
	const run = (name: string, args: Record<string, unknown>) => tools.invoke(name, args as never, false, undefined, "0/t1");
	// Paths are the sandbox's: /w is scratch, /w/<mount> is the mount (read-only).
	assert.equal((await run("read", { path: "/w/data/notes.txt", offset: 2 })).text, "line 2");
	assert.equal((await run("write", { path: "data/x", content: "no" })).isError, true);
	assert.equal((await run("write", { path: "out.txt", content: "yes yes" })).text, "wrote 7 characters to out.txt");
	assert.equal((await run("edit", { path: "out.txt", oldText: "yes", newText: "no" })).isError, true, "oldText must occur once");
	assert.equal((await run("edit", { path: "out.txt", oldText: "yes yes", newText: "no" })).text, "edited out.txt");
	assert.equal(readFileSync(join(dir, "scratch", "out.txt"), "utf8"), "no");
	assert.deepEqual((await run("ls", {})).value, ["out.txt"]);
	assert.equal((await run("read", { path: "/etc/passwd" })).isError, true);
	// read returns images as image content.
	assert.deepEqual((await run("read", { path: "/w/data/dot.png" })).images, [{ data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"), mimeType: "image/png" }]);
	// Declared but not buildable here: bash says so, typed as an error for the model.
	assert.match((await run("bash", { command: "id" })).text, /no sandbox: test/);
	const refused = await tools.invoke("exec", { command: "id" }, true, undefined, "0/t1");
	assert.equal(refused.isError, true);
	assert.match(refused.text, /not available/);
	assert.ok(s.entries.some((e) => e.kind === "tool_call" && e.tool === "exec"));
});

/** A spec whose tool sources are the fixture MCP server (counting its calls) and a fixture toolset. */
function withSources(tools: readonly ToolDesc[], recorded = new Map<string, Json>()) {
	const count = join(tmp(), "count.txt");
	const sources = new ToolSources({
		decl: { mcp: { mcpServers: { fx: { command: process.execPath, args: [resolve(here, "fixtures/mcp-server.ts")], env: { TOKEN: "${TOKEN}", COUNT_FILE: "${COUNT_FILE}" } } } }, mcpServers: { fx: { sandbox: null, network: "full" } }, toolsets: {} } as never,
		workflowDir: here,
		runDir: tmp(),
		boxes: null,
		env: { TOKEN: "s3cret", COUNT_FILE: count },
	});
	const records: [string, Json][] = [];
	const s = spec({ declaration: { ...spec().declaration, tools }, connect: (source) => sources.connect(source), recorded, record: (call, result) => void records.push([call, result]) });
	return { s, records, count: () => (existsSync(count) ? readFileSync(count, "utf8").trim().split("\n") : []) };
}

test("MCP tools through pi-mcp: a tool ref, a whole server (read-only tools only, the rest in a warning), secrets only in the server process", async () => {
	const { s } = withSources([{ kind: "mcp_tool", server: "fx", tool: "echo" }, { kind: "mcp_server", server: "fx" }]);
	const tools = await buildNodeTools(s);
	try {
		assert.deepEqual(tools.names.filter((n) => n.startsWith("mcp__")).sort(), ["mcp__fx__echo", "mcp__fx__search", "mcp__fx__slow"]);
		const r = await tools.invoke("mcp__fx__echo", { text: "hi" }, false, undefined, "0/t1");
		assert.equal(r.text, "hi; token=present");
		const notes = s.entries.filter((e) => e.kind === "note").map((e) => (e as { text: string }).text);
		assert.ok(notes.some((n) => /only tools annotated readOnlyHint are given; excluded: echo, other, wipe, post/.test(n)), notes.join("\n"));
		assert.ok(notes.some((n) => /tool mcp__fx__echo may write outside \(unannotated\)/.test(n)), "the write rule applies when the tool list is built");
		assert.ok(!JSON.stringify(s.entries).includes("s3cret"), "the secret never reaches the transcript");
	} finally {
		await tools.close();
	}
});

test("external results are journaled as { tool, args, outcome } under <turn>/<call id>; a reissue answers from the journal only on a match; codemode keys nest", async () => {
	const first = withSources([{ kind: "mcp_tool", server: "fx", tool: "search" }]);
	const tools = await buildNodeTools(first.s);
	tools.agentTools();
	try {
		await tools.invoke("mcp__fx__search", { q: "a" }, false, undefined, tools.key("call_0"));
		await tools.invoke("codemode", { code: "await tools.mcp__fx__search({ q: 'b' }); await tools.mcp__fx__search({ q: 'c' }); return 1;" }, false, undefined, tools.key("call_1"));
	} finally {
		await tools.close();
	}
	assert.deepEqual(first.records.map(([k]) => k), ["0/call_0", "0/call_1/0", "0/call_1/1"]);
	assert.deepEqual(first.records[0]![1], { tool: "mcp:fx/search", args: { q: "a" }, outcome: { text: JSON.stringify({ hits: ["a-1", "a-2"] }), value: { hits: ["a-1", "a-2"] }, isError: false } });
	assert.equal(first.count().length, 3);
	// Reissued with the journal: matching calls hit it; a reused id with other arguments is a miss (logged), and called.
	const again = withSources([{ kind: "mcp_tool", server: "fx", tool: "search" }], new Map(first.records));
	const reissued = await buildNodeTools(again.s);
	reissued.agentTools();
	try {
		assert.equal((await reissued.invoke("mcp__fx__search", { q: "a" }, false, undefined, "0/call_0")).text, JSON.stringify({ hits: ["a-1", "a-2"] }));
		await reissued.invoke("codemode", { code: "await tools.mcp__fx__search({ q: 'b' }); await tools.mcp__fx__search({ q: 'c' }); return 1;" }, false, undefined, "0/call_1");
		assert.deepEqual(again.count(), [], "nothing called again");
		await reissued.invoke("mcp__fx__search", { q: "z" }, false, undefined, "0/call_0");
		assert.deepEqual(again.count(), ["search"]);
		assert.ok(again.s.entries.some((e) => e.kind === "note" && /journaled result 0\/call_0 is for another call/.test((e as { text: string }).text)));
		// A record that does not parse is a miss too.
		const bad = withSources([{ kind: "mcp_tool", server: "fx", tool: "search" }], new Map([["0/call_0", "garbage"]]));
		const t3 = await buildNodeTools(bad.s);
		await t3.invoke("mcp__fx__search", { q: "a" }, false, undefined, "0/call_0");
		await t3.close();
		assert.deepEqual(bad.count(), ["search"]);
	} finally {
		await reissued.close();
	}
});

test("pi: an ask that is not the last tool call of its message still pauses; later calls in the message are not run; the reply reaches it after a host restart", async () => {
	const checkpoint = join(tmp(), "session.json");
	const s = () => spec({ declaration: { ...spec().declaration, tools: [{ kind: "ask" }] }, checkpoint });
	const first = faux();
	first.provider.setResponses([fauxAssistantMessage([fauxToolCall("ask", { message: "Louder?" }), fauxToolCall("codemode", { code: "return 1" })], { stopReason: "toolUse" })]);
	const asked = await (await first.executor.start(s())).turn();
	assert.deepEqual(asked.type === "asked" && asked.message, "Louder?");
	// A new executor rebuilds the dialogue from the checkpoint; the reply replaces the ask's placeholder.
	const second = faux();
	let seen = "";
	second.provider.setResponses([
		(ctx) => {
			seen = JSON.stringify(ctx.messages);
			return call("submit_result", { answer: 2 });
		},
	]);
	const done = await (await second.executor.start({ ...s(), turn: 1 })).turn("yes, louder");
	assert.equal(done.type, "submitted", JSON.stringify(done));
	assert.match(seen, /"toolName":"ask","content":\[\{"type":"text","text":"yes, louder/);
	assert.match(seen, /not run: this turn waits for the reply/);
});

test("pi: a reissued call whose checkpoint ends in an unsafe external tool call reports outcome_unknown and runs nothing", async () => {
	const { s, count } = withSources([{ kind: "mcp_tool", server: "fx", tool: "post" }]);
	const checkpoint = join(tmp(), "session.json");
	const messages = [
		{ role: "user", content: "Input", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "mcp__fx__post", arguments: {} }], stopReason: "toolUse", timestamp: 2, api: "faux", provider: "faux", model: "faux-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
	];
	writeFileSync(checkpoint, JSON.stringify({ messages, turns: 0, compacted: null }));
	const { executor } = faux();
	const session = await executor.start({ ...s, checkpoint });
	const r = await session.turn();
	await session.close();
	assert.deepEqual(r, { type: "outcome_unknown", tool: "mcp__fx__post", args: {}, usage: { usd: 0, tokens: 0, turns: 0 } });
	assert.deepEqual(count(), [], "not called again");
});
