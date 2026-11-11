// Actors and mailboxes: many senders to one mailbox in a journaled order
// that a resume replays; messages validated against the recipient's schema
// (a body's send throws MessageRejected, the caller's send rejects with
// it); a registered address and an outbox across the run boundary, with a
// detached run awaited with `next`, stopped and resumed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { lockHolder, runPaths, runsDir } from "../src/host/runs.ts";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { MessageRejected, run } from "../src/index.ts";
import { RunView } from "../src/status.ts";
import { here, project } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };

async function fixture() {
	const root = project({ "wf.ts": readFileSync(join(here, "fixtures/actors.ts"), "utf8") });
	return { root, wf: (await import(pathToFileURL(join(root, "wf.ts")).href)) as typeof import("./fixtures/actors.ts") };
}

const view = (root: string, id: string) => new RunView(runPaths(join(runsDir(root), id)));
const sleep = (ms: number) => new Promise((d) => setTimeout(d, ms));

test("a coordinator collects reports from several workers; a resume replays them in the journaled order", opts, async () => {
	const { root, wf } = await fixture();
	const r = await run(wf.coordinator, { workers: 4, sleep: 0.3 }, { detach: true });
	const paths = runPaths(join(runsDir(root), r.id));
	const box = () => Object.entries(view(root, r.id).snapshot as { mailboxes?: Record<string, { id: string; body: { worker: number } }[]> }).flatMap(([k, v]) => (k === "mailboxes" ? Object.values(v as Record<string, { id: string; body: { worker: number } }[]>) : []))[0] ?? [];
	// Kill it after two reports arrived.
	for (let i = 0; i < 200 && box().length < 2; i++) await sleep(25);
	const before = box().map((m) => m.body.worker);
	process.kill(lockHolder(paths)!, "SIGKILL");
	for (let i = 0; i < 50 && lockHolder(paths) !== null; i++) await sleep(50);
	assert.ok(before.length >= 2);
	const resumed = await r.resume({ detach: true });
	const n = await resumed.next({ timeout: "30s" });
	assert.equal(n.type, "finished");
	const out = (n as { output: { order: number[]; sum: number; rejected: string[] } }).output;
	// The reports that arrived before the kill keep their place; the order is the journal's.
	assert.deepEqual(out.order.slice(0, before.length), before);
	assert.deepEqual(out.order, box().map((m) => m.body.worker));
	assert.deepEqual([...out.order].sort(), [0, 1, 2, 3]);
	assert.equal(out.sum, 60);
	assert.deepEqual(out.rejected, ["/worker"]);
	// Ids are <mailbox>/<seq>.
	assert.deepEqual(box().map((m) => m.id.split("/").at(-1)), ["0", "1", "2", "3"]);
});

test("the caller talks to a registered address and reads an outbox; a detached run awaited with next, stopped and resumed", opts, async () => {
	const { wf } = await fixture();
	const r = await run(wf.echo, {}, { detach: true });
	for (let i = 0; i < 200 && !("registered:user" in (await (r as unknown as { view(): RunView }).view().facts)); i++) await sleep(25);
	const a = await r.send("user", "a");
	assert.match(a, /\/0$/);
	const first = await r.next({ timeout: "10s" });
	assert.deepEqual(first, { type: "message", outbox: "reply", id: first.type === "message" ? first.id : "", replyTo: a, body: "echo: a" });
	await assert.rejects(r.send("user", { not: "a string" }), (e: unknown) => e instanceof MessageRejected && e.errors[0]!.path === "/");
	assert.equal((await r.next({ timeout: "1s" })).type, "timeout");
	// Stopped: a message sent now persists and is delivered on resume.
	await r.stop();
	assert.equal((await r.next({ timeout: "1s" })).type, "stopped");
	await r.send("user", "b");
	await r.resume({ detach: true });
	const second = await r.next({ timeout: "10s" });
	assert.equal(second.type === "message" && second.body, "echo: b", "the reply to a is not sent again");
	await r.send("user", "bye");
	assert.deepEqual(await r.next({ timeout: "10s" }), { type: "finished", output: { heard: 2 } });
});
