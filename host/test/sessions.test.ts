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
	assert.deepEqual(node.type === "node_idle" && node.cause, { type: "asked", message: "Louder?" });
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

test("a second call of a session while its first is in flight is refused: session_busy", async () => {
	const done = await runWorkflow({ ...opts(join(tmp(), "run")), executor: executor(), input: { mode: "busy" } });
	assert.deepEqual(done.outcome, { type: "done", value: { second: "session_busy" } });
});
