// Sessions on the pi executor (faux provider): a call continues its
// session's dialogue; restarting a call rewinds the session to before it;
// a second call in flight is refused; a pending `ask` survives the host.

import assert from "node:assert/strict";
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

test("a session's second call continues its first call's dialogue; a pending ask survives a host restart", async () => {
	const dir = join(tmp(), "run");
	const asking = await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "two" } });
	const node = asking.run.nodes.find((n) => n.id === "#0:1")!;
	assert.deepEqual(node.type === "node_idle" && node.cause, { type: "question", message: "Louder?" });
	// A new host, a new executor: the dialogue is rebuilt from the checkpoint and the reply is the ask's result.
	const done = await runWorkflow({ ...opts(dir), executor: executor(), sends: [{ node: "#0:1", text: "yes, louder" }] });
	assert.deepEqual(done.outcome, {
		type: "done",
		value: { one: { heard: 1, saw_ask: false, reply: "" }, two: { heard: 2, saw_ask: true, reply: "yes, louder" } },
	});
});

test("restarting a session call rewinds the session to before that call", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "two" } });
	const { appendInbox, runPaths } = await import("../src/host/store.ts");
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: "#0:1", note: "no need to ask", by: "human" });
	const done = await runWorkflow({ ...opts(dir), executor: executor() });
	// The first call's dialogue is kept (heard 2); the discarded attempt's ask is gone.
	assert.deepEqual(done.outcome, {
		type: "done",
		value: { one: { heard: 1, saw_ask: false, reply: "" }, two: { heard: 2, saw_ask: false, reply: "" } },
	});
});

test("a call made while the session's previous call is in flight waits for it: calls run in the order they were made", async () => {
	const dir = join(tmp(), "run");
	const done = await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "queued" } });
	assert.deepEqual(done.outcome, { type: "done", value: { first: { heard: 1, saw_ask: false, reply: "" }, second: { heard: 2, saw_ask: false, reply: "" } } });
	// A fork re-executes against the journal: the same ids and slots, every call a hit.
	const { forkRun } = await import("../src/host/query.ts");
	const fork = forkRun(dir, join(tmp(), "fork"));
	const forked = await runWorkflow({ ...opts(fork.dir), executor: executor() });
	assert.deepEqual(forked.outcome, done.outcome);
});

test("a session called from a parallel branch is refused (foreign_session), deterministically; its own branch may call it", async () => {
	const done = await runWorkflow({ ...opts(join(tmp(), "run")), executor: executor(), input: { mode: "foreign" } });
	assert.deepEqual(done.outcome, { type: "done", value: { branch: "foreign_session", after: { heard: 1, saw_ask: false, reply: "" } } });
});

test("a call after a cancelled one continues the dialogue the cancelled call left", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "cancel" } });
	const { appendInbox, runPaths } = await import("../src/host/store.ts");
	appendInbox(runPaths(dir), { id: "c1", type: "cancel_node", node: "#0:1", by: "human" });
	const done = await runWorkflow({ ...opts(dir), executor: executor() });
	assert.deepEqual(done.outcome, {
		type: "done",
		value: { one: { heard: 1, saw_ask: false, reply: "" }, two: "cancelled_by_owner", three: { heard: 3, saw_ask: true, reply: "" } },
	});
});

test("a session call whose previous dialogue is missing is refused (dialogue_missing), never started fresh", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "two" } });
	const { readdirSync, rmSync } = await import("node:fs");
	for (const f of readdirSync(join(dir, "sessions"))) rmSync(join(dir, "sessions", f));
	const { appendInbox, runPaths } = await import("../src/host/store.ts");
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: "#0:1", by: "human" });
	const done = await runWorkflow({ ...opts(dir), executor: executor() });
	assert.equal(done.outcome?.type, "failed");
	assert.match(JSON.stringify(done.outcome), /refused: dialogue_missing/);
});

test("a crash between journaling a call's result and saving its dialogue does not break the session: the dialogue is recovered from the call's work dir", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ ...opts(dir), executor: executor(), input: { mode: "two" } });
	const { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
	// The state the crash window leaves: call 0's result is in the log, its dialogue is not in
	// sessions/, and its work dir (checkpoint and slot) still exists.
	// Call 1 waits on its question, so the only saved dialogue is call 0's.
	const files = readdirSync(join(dir, "sessions"));
	assert.equal(files.length, 1);
	const saved = files[0];
	// A slot is `<hex>#<occurrence>`; its file name has `_` for `#`.
	const slot = saved!.replace(/_(\d+)\.json$/, "#$1");
	mkdirSync(join(dir, "work", "_0_0"), { recursive: true });
	cpSync(join(dir, "sessions", saved!), join(dir, "work", "_0_0", "session.json"));
	writeFileSync(join(dir, "work", "_0_0", "call.json"), JSON.stringify({ digest: slot, previous: null }));
	rmSync(join(dir, "sessions", saved!));
	// Call 1 is restarted, so it needs call 0's dialogue again.
	const { appendInbox, runPaths } = await import("../src/host/store.ts");
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: "#0:1", note: "no need to ask", by: "human" });
	const done = await runWorkflow({ ...opts(dir), executor: executor() });
	assert.deepEqual(done.outcome, { type: "done", value: { one: { heard: 1, saw_ask: false, reply: "" }, two: { heard: 2, saw_ask: false, reply: "" } } });
});
