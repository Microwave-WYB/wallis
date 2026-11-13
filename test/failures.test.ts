// Failures (docs/design.md §6, §7): an actor's failure is never swallowed (the spawner handles it,
// or it fails the spawning body); a failed actor's mailbox is closed; actors in a ctx.loop step
// close with it; and a failed run names the failure that ended it first.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { attach, NodeFailed, run } from "../src/index.ts";
import { faux } from "./fixtures/faux.ts";
import { here, project } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };

async function fixture() {
	const root = project({ "wf.ts": readFileSync(join(here, "fixtures/failing.ts"), "utf8") }, { models: { default: "faux/m" }, executor: join(here, "fixtures/faux.ts") });
	return { root, wf: (await import(pathToFileURL(join(root, "wf.ts")).href)) as typeof import("./fixtures/failing.ts") };
}

const failedRun = async (p: Promise<unknown>) => {
	try {
		await p;
	} catch (e) {
		if (e instanceof NodeFailed) return e;
		throw e;
	}
	throw new Error("the run did not fail");
};

test("an actor nobody awaits that throws fails its spawning body, and the run's failure names it", opts, async () => {
	const { root, wf } = await fixture();
	const e = await failedRun(run(wf.unawaited, {}));
	assert.match(e.call.label, /^crasher \(wf\.ts:\d+\)$/);
	assert.match(e.message, /actor crasher .* failed: boom/);
	const id = (await import("node:fs")).readdirSync(join(root, ".wallis/runs"))[0]!;
	const [first] = (await attach(wf.unawaited, id).status()).failed;
	assert.match(first!.label, /^crasher/);
	assert.match(first!.tail, /boom/);
});

test("an awaited actor's failure is the spawner's to catch; its mailbox is closed after it", opts, async () => {
	const { wf } = await fixture();
	assert.deepEqual((await run(wf.awaited, {})).output, { caught: "cannot handle job 1", after: "closed" });
});

test("the grade scenario: a renderer that throws outside its per-job try ends the run instead of idling", opts, async () => {
	const { wf } = await fixture();
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("send", { to: "renderer", message: { frame: "2835" } } as never)], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxText("Waiting for the render.")]),
	]);
	const started = Date.now();
	const e = await failedRun(run(wf.grade, {}));
	assert.match(e.call.label, /^renderer/);
	assert.match(e.message, /renderer crashed on 2835/);
	assert.ok(Date.now() - started < 30_000);
});

test("an actor spawned in a ctx.loop step closes when the step returns", opts, async () => {
	const { wf } = await fixture();
	assert.deepEqual((await run(wf.looping, {})).output, { reason: "closed" });
});

test("a failed run names first the failure that ended it, not one the body handled", opts, async () => {
	const { root, wf } = await fixture();
	const e = await failedRun(run(wf.twoFailures, {}));
	assert.match(e.message, /broken 2/);
	const id = (await import("node:fs")).readdirSync(join(root, ".wallis/runs"))[0]!;
	const h = attach(wf.twoFailures, id);
	const failed = (await h.status()).failed;
	assert.deepEqual(failed.map((f) => f.tail), ["broken 2", "broken 1"]);
	await assert.rejects(h.done(), (x: unknown) => x instanceof NodeFailed && x.call.id === failed[0]!.id);
});

test("an actor's handler attached at spawn handles a failure that happens during a later await; one reached only after it is too late", opts, async () => {
	const { wf } = await fixture();
	assert.deepEqual((await run(wf.handledAtSpawn, {})).output, { caught: "boom" });
	await assert.rejects(run(wf.handledTooLate, {}), (e: unknown) => e instanceof NodeFailed && /boom/.test(e.message));
});
