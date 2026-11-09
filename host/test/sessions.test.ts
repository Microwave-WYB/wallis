// Sessions on the pi executor (faux provider): a call continues its
// session's dialogue; restarting a call rewinds the session to before it;
// a second call in flight is refused; a pending `ask` survives the host.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { runWorkflow } from "../src/host/index.ts";
import { PiExecutor } from "../src/host/pi.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const workflow = resolve(here, "fixtures/sessions/workflow.ts");

type Msg = { role: string; content: unknown };
const text = (m: Msg): string => (typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""));
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

/**
 * The model counts the inputs it has heard; on input "two" it first asks
 * (unless an operator note restarted it), then submits with the reply.
 */
function executor() {
	const provider = fauxProvider({ models: [{ id: "faux-1" }] });
	const respond = (context: { messages: Msg[] }) => {
		const messages = context.messages;
		const inputs = messages.filter((m) => m.role === "user" && /"say": "/.test(text(m)));
		const current = inputs.at(-1)!;
		const after = messages.slice(messages.indexOf(current) + 1);
		const asked = after.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes('"name":"ask"'));
		const reply = after.filter((m) => m.role === "toolResult").map(text).at(-1) ?? "";
		const sawAsk = messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes('"name":"ask"'));
		if (text(current).includes('"say": "two"') && !text(current).includes("Operator note") && !asked) return call("ask", { message: "Louder?" });
		return call("submit_result", { heard: inputs.length, saw_ask: sawAsk, reply: reply.replace(/\s*\[Turn \d+ of \d+\]$/, "") });
	};
	provider.setResponses(Array.from({ length: 50 }, () => respond as never));
	const models = createModels();
	models.setProvider(provider.provider);
	return new PiExecutor({ models, retryDelaysMs: [] });
}

const opts = (dir: string) => ({ workflow, dir, confine: "off" as const, inboxPollMs: null });

test("a call of the session value a call answered with continues its dialogue; a pending ask survives a host restart", async () => {
	const dir = join(tmp(), "run");
	const asking = await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "two" } });
	const node = asking.run.nodes.find((n) => n.id === "#1")!;
	assert.deepEqual(node.type === "node_idle" && node.cause, { type: "question", message: "Louder?" });
	// A new host, a new executor: the dialogue is rebuilt from the checkpoint and the reply is the ask's result.
	const done = await runWorkflow({ ...opts(dir), executor: executor(), sends: [{ node: "#1", text: "yes, louder" }] });
	assert.deepEqual(done.outcome, {
		type: "done",
		value: { one: { heard: 1, saw_ask: false, reply: "" }, two: { heard: 2, saw_ask: true, reply: "yes, louder" } },
	});
	// The second call's checkpoint is a delta from the first call's dialogue, not a copy of it.
	const { EventLog } = await import("../src/host/log.ts");
	const { blobPath } = await import("../src/host/artifacts.ts");
	const second = new EventLog(join(dir, "log.jsonl")).read().filter((e) => e.type === "agent_progressed" && e.id === "#1").at(-1) as { dialogue: string };
	assert.match(readFileSync(blobPath(dir, second.dialogue), "utf8"), /^\{"wallis_dialogue":"delta","base":"sha256:[0-9a-f]{64}","keep":\d+/);
});

test("restarting a session call is calling its session value again: the call before it is kept", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "two" } });
	const { appendInbox, runPaths } = await import("../src/host/store.ts");
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: "#1", note: "no need to ask", by: "human" });
	const done = await runWorkflow({ ...opts(dir), executor: executor() });
	// The first call's dialogue is kept (heard 2); the discarded attempt's ask is gone.
	assert.deepEqual(done.outcome, {
		type: "done",
		value: { one: { heard: 1, saw_ask: false, reply: "" }, two: { heard: 2, saw_ask: false, reply: "" } },
	});
});

test("calling one session value again is a branch, in this ctx or a parallel one, deterministically on fork and replay", async () => {
	const dir = join(tmp(), "run");
	const done = await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "branch" } });
	const quiet = { heard: 2, saw_ask: false, reply: "" };
	const expected = { type: "done", value: { one: { heard: 1, saw_ask: false, reply: "" }, here: quiet, there: quiet, other: quiet } };
	assert.deepEqual(done.outcome, expected);
	// Three calls, each its own branch from the first call's session value.
	const sessions = done.run.sessions;
	const first = sessions.find((s) => s.call === "#0")!;
	assert.equal(first.from, null);
	assert.deepEqual(sessions.filter((s) => s.from === first.id).map((s) => s.call).sort(), ["#1", "#2.x#0", "#3.0#0"]);
	// A fork re-executes the body against the journal: every call a hit, the same values.
	const { forkRun } = await import("../src/host/query.ts");
	const fork = forkRun(dir, join(tmp(), "fork"));
	const forked = await runWorkflow({ ...opts(fork.dir), executor: executor() });
	assert.deepEqual(forked.outcome, expected);
	assert.deepEqual(forked.run.sessions, sessions);
	const replayed = await runWorkflow({ ...opts(dir), executor: executor() });
	assert.deepEqual(replayed.outcome, expected);
});

test("a cancelled call answers with no session value: the next call is of the value before it", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "cancel" } });
	const { appendInbox, runPaths } = await import("../src/host/store.ts");
	appendInbox(runPaths(dir), { id: "c1", type: "cancel_node", node: "#1", by: "human" });
	const done = await runWorkflow({ ...opts(dir), executor: executor() });
	assert.deepEqual(done.outcome, {
		type: "done",
		value: { one: { heard: 1, saw_ask: false, reply: "" }, two: "cancelled_by_owner", three: { heard: 2, saw_ask: false, reply: "" } },
	});
});

test("a session call whose previous dialogue blob is missing is refused (dialogue_missing), never started fresh", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "two" } });
	const { rmSync } = await import("node:fs");
	const { EventLog } = await import("../src/host/log.ts");
	const { blobPath } = await import("../src/host/artifacts.ts");
	// Every dialogue blob call 0 left: the store lost them.
	for (const e of new EventLog(join(dir, "log.jsonl")).read()) if (e.type === "agent_progressed" && e.id === "#0") rmSync(blobPath(dir, e.dialogue), { force: true });
	const { appendInbox, runPaths } = await import("../src/host/store.ts");
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: "#1", by: "human" });
	const done = await runWorkflow({ ...opts(dir), executor: executor() });
	assert.equal(done.outcome?.type, "failed");
	assert.match(JSON.stringify(done.outcome), /refused: dialogue_missing/);
});

test("a dialogue blob keeps the executor's state apart from wallis's fields: a key of the state is never taken for a delta", async () => {
	const { putDialogue, readDialogue } = await import("../src/host/dialogues.ts");
	const dir = tmp();
	const base = { messages: [{ role: "user", content: "one" }], wallis_delta: { base: "nope", keep: 9 } };
	const first = putDialogue(dir, base as never, null);
	assert.deepEqual(readDialogue(dir, first), base);
	const next = { messages: [...base.messages, { role: "assistant", content: "two" }], wallis_delta: "still the executor's" };
	const second = putDialogue(dir, next as never, { digest: first, state: base as never });
	assert.deepEqual(readDialogue(dir, second), next);
});
