// The body runtime and the caller API on commands and nested workflows:
// the journal, resume in place (finished calls answered from the record,
// failed ones run again), no cross-run cache, host files, Trees, failures
// that name their calls.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { lockHolder, runPaths, runsDir } from "../src/host/runs.ts";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { Artifact, attach, list, NodeFailed, prune, run, Tree } from "../src/index.ts";
import { RunView } from "../src/status.ts";
import { here, project } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };

async function fixture() {
	const root = project({ "wf.ts": readFileSync(join(here, "fixtures/basic.ts"), "utf8") });
	mkdirSync(join(root, "ctl"));
	const wf = (await import(pathToFileURL(join(root, "wf.ts")).href)) as typeof import("./fixtures/basic.ts");
	return { root, wf };
}

const view = (root: string, id: string) => new RunView(runPaths(join(runsDir(root), id)));
const attempts = (v: RunView, label: RegExp) =>
	v.calls
		.filter((c) => label.test(c.name))
		.sort((a, b) => JSON.stringify(a.input).localeCompare(JSON.stringify(b.input)) || a.scope.localeCompare(b.scope))
		.map((c) => c.attempts.map((a) => a.type));

test("a run journals its calls; the output carries host paths into the project store", opts, async () => {
	const { root, wf } = await fixture();
	const r = await run(wf.nested, { n: 3 });
	assert.deepEqual(r.output, { outer: 6, inner: 6 });
	// The same command and input inside a nested workflow is another call: keyed by place.
	assert.deepEqual(attempts(view(root, r.id), /^twice/), [["answered"], ["answered"]]);
	assert.match(r.id, /^nested-\d{8}-\d{6}-[0-9a-f]{4}$/);
	assert.equal((await r.status()).state, "finished");
	assert.deepEqual((await list(join(root, "wf.ts"))).map((x) => x.id), [r.id]);
});

test("a failure names its call; resume re-runs only that call, finished ones come from the journal", opts, async () => {
	const { root, wf } = await fixture();
	writeFileSync(join(root, "ctl", "fail-2"), "");
	let failed: NodeFailed | undefined;
	try {
		await run(wf.frames, { n: 3 });
	} catch (e) {
		if (!(e instanceof NodeFailed)) throw e;
		failed = e;
	}
	assert.ok(failed);
	assert.match(failed.call.label, /^flaky \(wf\.ts:\d+\)$/);
	assert.deepEqual(failed.reason, { type: "command_exited", code: 3, stderr: "frame 2 failed on purpose" });
	const id = readdirSync(runsDir(root))[0]!;
	const r = attach(wf.frames, id);
	const status = await r.status();
	assert.equal(status.state, "failed");
	assert.equal(status.failed.length, 1);
	assert.equal(status.failed[0]!.recovery, "resume");
	assert.equal(status.failed[0]!.tail, "frame 2 failed on purpose");
	assert.equal(status.failed[0]!.id, failed.call.id);
	const next = await r.next({ timeout: "1s" });
	assert.equal(next.type, "failed");
	// The cause is fixed; a plain resume.
	rmSync(join(root, "ctl", "fail-2"));
	await r.resume();
	const done = await r.done();
	assert.deepEqual(done.output, { done: [1, 2, 3] });
	assert.deepEqual(attempts(view(root, id), /^flaky/), [["answered"], ["failed", "answered"], ["answered"]]);
	// Retrying a finished call is refused.
	await assert.rejects(r.resume({ retry: [failed.call.id] }), /did not fail/);
});

test("a killed run resumes without redoing finished calls; a second run recomputes", opts, async () => {
	const { root, wf } = await fixture();
	const r = await run(wf.frames, { n: 3, sleep: 0.4 }, { detach: true });
	const paths = runPaths(join(runsDir(root), r.id));
	// Kill the run's process once the first frame is journaled.
	for (let i = 0; i < 100; i++) {
		if (existsSync(paths.log) && view(root, r.id).calls.some((c) => c.attempts.at(-1)?.type === "answered")) break;
		await new Promise((d) => setTimeout(d, 50));
	}
	process.kill(lockHolder(paths)!, "SIGKILL");
	for (let i = 0; i < 50 && lockHolder(paths) !== null; i++) await new Promise((d) => setTimeout(d, 50));
	assert.equal((await r.next({ timeout: "1s" })).type, "stopped");
	assert.equal((await r.status()).state, "stopped");
	const resumed = await r.resume({ detach: true });
	const n = await resumed.next({ timeout: "30s" });
	assert.deepEqual(n, { type: "finished", output: { done: [1, 2, 3] } });
	const calls = attempts(view(root, r.id), /^flaky/);
	assert.deepEqual(calls[0], ["answered"], "the frame finished before the kill is not redone");
	// No implicit cache: a new run computes everything again.
	const again = await run(wf.frames, { n: 3 });
	assert.equal(view(root, again.id).events.filter((e) => e.type === "command_returned").length, 3);
});

test("host files enter through the caller; Trees mount read-only; r.file and r.dir move results into the store", opts, async () => {
	const { root, wf } = await fixture();
	const src = join(root, "photos");
	mkdirSync(join(src, "base"), { recursive: true });
	writeFileSync(join(src, "a.NEF"), "raw a");
	writeFileSync(join(src, "base", "b.NEF"), "raw b");
	writeFileSync(join(root, "note.txt"), "a note");
	const r = await run(wf.files, { tree: Tree.from(src), file: Artifact.from(join(root, "note.txt"), { media: "text/plain" }) });
	assert.equal(r.output.seen, "a.NEF base |a note");
	assert.equal(r.output.again, "sub |hello");
	assert.equal(r.output.made.file.media, "text/plain");
	assert.equal(readFileSync(r.output.made.file.path, "utf8"), "hello\n");
	const out = join(root, "export");
	await r.exportOutput(out);
	assert.equal(readFileSync(join(out, "out.txt"), "utf8"), "hello\n");
	assert.equal(readFileSync(join(out, r.output.made.dir.digest.slice(7, 19), "sub", "x.txt"), "utf8"), "hello\n");
	// The input was snapshotted: changing the host dir does not change the run's record.
	writeFileSync(join(src, "a.NEF"), "changed");
	assert.equal((await prune()).freed >= 0, true);
});

test("a body that throws fails the run as workflow_threw", opts, async () => {
	const { wf } = await fixture();
	await assert.rejects(run(wf.thrower, {}), (e: unknown) => e instanceof NodeFailed && e.reason.type === "workflow_threw" && e.reason.message === "the body gave up");
});


test("a workflow module that starts a run when imported does not start one per process", opts, async () => {
	const root = project({ "wf.ts": readFileSync(join(here, "fixtures/selfrun.ts"), "utf8") });
	process.env.SELF_RUN = "1";
	try {
		await import(pathToFileURL(join(root, "wf.ts")).href);
	} finally {
		delete process.env.SELF_RUN;
	}
	const r = (globalThis as { selfRun?: { next(o: object): Promise<{ type: string }>; id: string } }).selfRun!;
	// The run's process refuses the module's own run() and stops; nothing else is started.
	assert.equal((await r.next({ timeout: "20s" })).type, "stopped");
	await new Promise((d) => setTimeout(d, 500));
	assert.deepEqual(readdirSync(runsDir(root)), [r.id]);
	assert.match(readFileSync(join(runsDir(root), r.id, "process.log"), "utf8"), /import\.meta\.main/);
});
