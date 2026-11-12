// The pi executor on the v2 agent model, on pi-ai's faux provider (no real
// model calls): one-shot and session calls, the send tool (a rejected
// message comes back with its errors), mailbox turns, the turn budget as a
// decided failure recovered with resume({ retry, turns }), invalid output.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { runPaths, runsDir } from "../src/host/runs.ts";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { attach, NodeFailed, run } from "../src/index.ts";
import { RunView } from "../src/status.ts";
import { faux, messages, text } from "./fixtures/faux.ts";
import { here, project } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };

async function fixture() {
	const root = project({ "wf.ts": readFileSync(join(here, "fixtures/agents.ts"), "utf8") }, { models: { default: "faux/m" }, executor: join(here, "fixtures/faux.ts") });
	return { root, wf: (await import(pathToFileURL(join(root, "wf.ts")).href)) as typeof import("./fixtures/agents.ts") };
}

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const submit = (result: unknown) => call("submit_result", { result });
const say = (t: string) => fauxAssistantMessage([fauxText(t)]);
const view = (root: string, id: string) => new RunView(runPaths(join(runsDir(root), id)));

test("a one-shot call returns the output only; a session call continues its own dialogue", opts, async () => {
	const { wf } = await fixture();
	faux.setResponses([
		(ctx) => {
			assert.match(text(messages(ctx).at(-1)), /"question": "two\?"/);
			return submit({ answer: 2 });
		},
	]);
	assert.deepEqual((await run(wf.one, { question: "two?" })).output, { answer: 2 });
	faux.setResponses([
		() => submit({ answer: 1 }),
		(ctx) => {
			// The second call sees the first call's dialogue, then its own input.
			const all = messages(ctx).map(text).join("\n");
			assert.match(all, /"question": "first"/);
			assert.match(text(messages(ctx).at(-1)), /"question": "second"/);
			return submit({ answer: 2 });
		},
	]);
	assert.deepEqual((await run(wf.dialogue, {})).output, { first: 1, second: 2 });
});

test("an invalid result comes back with its errors; the agent fixes it", opts, async () => {
	const { wf } = await fixture();
	faux.setResponses([
		() => submit({ answer: "two" }),
		(ctx) => {
			const last = messages(ctx).at(-1)!;
			assert.equal(last.isError, true);
			assert.match(text(last), /answer/);
			return submit({ answer: 2 });
		},
	]);
	assert.deepEqual((await run(wf.one, { question: "two?" })).output, { answer: 2 });
});

test("the send tool: a rejected message comes back with its errors; the reply enters a later turn", opts, async () => {
	const { root, wf } = await fixture();
	faux.setResponses([
		(ctx) => {
			assert.match(text(messages(ctx).at(-1)), /send/);
			return call("send", { to: "renderer", message: {} });
		},
		(ctx) => {
			const last = messages(ctx).at(-1)!;
			assert.equal(last.isError, true);
			assert.match(text(last), /frame/);
			return call("send", { to: "renderer", message: { frame: "2835" } });
		},
		(ctx) => {
			// The send's result, then the reply that arrived during that turn, in the next turn.
			assert.match(text(messages(ctx).at(-2)), /sent: message id/);
			const last = text(messages(ctx).at(-1));
			assert.match(last, /\[message agent:[^\]]+\/0 from actor:/);
			assert.match(last, /rendered 2835/);
			return submit({ got: "rendered 2835" });
		},
	]);
	const r = await run(wf.asking, {});
	assert.deepEqual(r.output, { got: "rendered 2835", jobs: 1 });
	const v = view(root, r.id);
	assert.equal(v.events.filter((e) => e.type === "messages_taken").length, 1);
	// The invalid send was never journaled: only the valid job and its reply.
	assert.equal(v.events.filter((e) => e.type === "sent").length, 2);
});

test("an address whose mailbox schema differs from the Address input fails the call before it starts", opts, async () => {
	const { wf } = await fixture();
	faux.setResponses([]);
	await assert.rejects(run(wf.mismatched, {}), (e: unknown) => e instanceof NodeFailed && /another message schema/.test(e.message));
});

test("a turn limit is a decided failure: resume alone answers it again; resume({ retry, turns }) continues the same session", opts, async () => {
	const { root, wf } = await fixture();
	faux.setResponses([() => say("Uploading the first."), () => say("Uploading the second.")]);
	let failure: NodeFailed | undefined;
	await run(wf.budget, { files: 3 }).catch((e: NodeFailed) => (failure = e));
	assert.equal(failure?.reason.type, "turn_limit_reached");
	assert.equal(failure.reason.type === "turn_limit_reached" && failure.reason.turns, 2);
	const id = failure.call.id;
	const runId = view(root, (await import("node:fs")).readdirSync(runsDir(root))[0]!).paths.id;
	const r = attach(wf.budget, runId);
	const [f] = (await r.status()).failed;
	assert.equal(f?.recovery, "retry");
	assert.match(f!.tail, /Uploading the second/);
	// A plain resume re-runs nothing: the model is not called again.
	const calls = faux.state.callCount;
	await r.resume();
	assert.equal(faux.state.callCount, calls);
	assert.equal((await r.status()).state, "failed");
	// Retried with more turns: the same dialogue continues.
	faux.setResponses([
		(ctx) => {
			const all = messages(ctx).map(text).join("\n");
			assert.match(all, /Uploading the first\.[\s\S]*Uploading the second\./);
			assert.match(text(messages(ctx).at(-1)), /You have 3 more turns/);
			return submit({ uploaded: 3 });
		},
	]);
	await r.resume({ retry: [id], turns: 3 });
	assert.deepEqual((await r.done()).output, { uploaded: 3 });
	const v = view(root, runId);
	assert.deepEqual(v.calls.map((c) => c.attempts.map((a) => a.type)), [["failed", "answered"]]);
});

test("three invalid results are a decided output_invalid with the errors", opts, async () => {
	const { wf } = await fixture();
	faux.setResponses([() => submit({ answer: "x" }), () => submit({ answer: "y" }), () => submit({ answer: "z" })]);
	await assert.rejects(run(wf.one, { question: "?" }), (e: unknown) => e instanceof NodeFailed && e.reason.type === "output_invalid" && e.reason.errors.some((x) => /answer/.test(x)));
});

test("a message sent with interrupt aborts the current turn and enters the next one", opts, async () => {
	const { root, wf } = await fixture();
	let sawCutOff = true;
	faux.setResponses([
		// A long turn (3 s): the interrupt aborts it before it is done.
		() => new Promise((done) => setTimeout(() => done(say("the long turn finished")), 3000)),
		(ctx) => {
			assert.match(text(messages(ctx).at(-1)), /stop and report/);
			// The aborted turn's reply is not in the dialogue.
			sawCutOff = messages(ctx).some((m) => /the long turn finished/.test(text(m)));
			return submit({ heard: "stop and report" });
		},
	]);
	const finished = run(wf.steered, {});
	const { readdirSync } = await import("node:fs");
	let id = "";
	for (let i = 0; i < 200 && !id; i++) {
		await new Promise((d) => setTimeout(d, 25));
		id = existsSync(runsDir(root)) ? (readdirSync(runsDir(root))[0] ?? "") : "";
	}
	const r = attach(wf.steered, id);
	for (let i = 0; i < 200; i++) {
		try {
			await r.send("steer", "stop and report", { interrupt: true });
			break;
		} catch (e) {
			if (!/registered no address/.test(String(e))) throw e;
			await new Promise((d) => setTimeout(d, 25));
		}
	}
	const started = Date.now();
	assert.deepEqual((await finished).output, { heard: "stop and report" });
	assert.equal(sawCutOff, false);
	assert.ok(Date.now() - started < 2900, "the interrupt did not wait for the turn to finish");
});

