// ~ in host paths; onExit on a detached resume; exportOutput failing loudly; a decided failure's
// session workspace after a resume; a workflow path holding ( ) : and spaces.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { attach, NodeFailed, run, Tree } from "../src/index.ts";
import { faux } from "./fixtures/faux.ts";
import { here, project, tmp } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };

async function fixture(sub = "") {
	const files = { [`${sub}wf.ts`]: readFileSync(join(here, "fixtures/low.ts"), "utf8"), [`${sub}data/x.txt`]: "bound\n", ...(sub ? { [`${sub}package.json`]: '{ "type": "module" }\n' } : {}) };
	const root = project(files, { models: { default: "faux/m" }, executor: join(here, "fixtures/faux.ts") });
	const dir = join(root, sub);
	return { root: dir, wf: (await import(pathToFileURL(join(dir, "wf.ts")).href)) as typeof import("./fixtures/low.ts") };
}

test("~ is the home dir in Tree.from and exportOutput", opts, async () => {
	const { wf } = await fixture();
	const home = tmp();
	mkdirSync(join(home, "scans"));
	writeFileSync(join(home, "scans", "a.txt"), "from home\n");
	const before = process.env.HOME;
	process.env.HOME = home;
	try {
		const r = await run(wf.reads, { t: Tree.from("~/scans") });
		assert.equal(r.output.text, "from home\nbound\n");
		await r.exportOutput("~/out");
		assert.ok(readdirSync(join(home, "out")).length === 1);
	} finally {
		process.env.HOME = before;
	}
});

test("exportOutput fails when a copy fails, never silently", opts, async () => {
	const { root, wf } = await fixture();
	mkdirSync(join(root, "d"));
	writeFileSync(join(root, "d", "a.txt"), "a\n");
	const r = await run(wf.reads, { t: Tree.from(join(root, "d")) });
	const out = join(root, "out");
	mkdirSync(out);
	// Where the Tree would go, a file: the copy cannot succeed.
	writeFileSync(join(out, r.output.t.digest.slice(7, 19)), "in the way");
	await assert.rejects(r.exportOutput(out), /exportOutput: copying Tree/);
});

test("a detached resume runs the run's onExit too", opts, async () => {
	const { root, wf } = await fixture();
	const flag = join(root, "flag");
	const marker = join(root, "exited");
	writeFileSync(flag, "");
	const r = await run(wf.flaky, { flag }, { detach: true, onExit: `touch ${marker}` });
	assert.equal((await r.next({ timeout: "20s" })).type, "failed");
	for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((d) => setTimeout(d, 50));
	rmSync(marker);
	rmSync(flag);
	const resumed = await r.resume({ detach: true });
	assert.equal((await resumed.next({ timeout: "20s" })).type, "finished");
	for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((d) => setTimeout(d, 50));
	assert.ok(existsSync(marker), "onExit ran after the resumed run");
});

test("a decided failure's session keeps its workspace after a resume (ctx.files)", opts, async () => {
	const { root, wf } = await fixture();
	const flag = join(root, "flag");
	writeFileSync(flag, "");
	faux.setResponses([() => fauxAssistantMessage([fauxToolCall("write", { path: "draft.md", content: "half a draft\n" } as never)], { stopReason: "toolUse" }), () => fauxAssistantMessage([fauxToolCall("ls", {} as never)], { stopReason: "toolUse" })]);
	await assert.rejects(run(wf.keepDraft, { flag }));
	rmSync(flag);
	const id = readdirSync(join(root, ".wallis/runs"))[0]!;
	// The resumed body gets the turn limit from the journal: the session's layers come from the record.
	await attach(wf.keepDraft, id).resume();
	const done = await attach(wf.keepDraft, id).done();
	assert.equal(readFileSync(join(done.output.draft.path, "draft.md"), "utf8"), "half a draft\n");
});

test("a workflow whose path holds ( ) : and spaces gets its label and its relative volumes right", opts, async () => {
	const { root, wf } = await fixture("My Proj (2024): v2/");
	mkdirSync(join(root, "d"));
	writeFileSync(join(root, "d", "a.txt"), "a\n");
	// The relative ./data bind resolves next to the workflow (its definition site).
	assert.equal((await run(wf.reads, { t: Tree.from(join(root, "d")) })).output.text, "a\nbound\n");
	assert.match((await import("../src/nodes.ts")).workflowDef(wf.reads).label, /^reads \(wf\.ts:\d+\)$/);
});

test("attach(wf, id) refuses a run of another workflow", opts, async () => {
	const { root, wf } = await fixture();
	const flag = join(root, "absent");
	await run(wf.flaky, { flag });
	const id = readdirSync(join(root, ".wallis/runs"))[0]!;
	assert.throws(() => attach(wf.reads, id), /is a run of flaky .*not of reads/);
	attach(wf.flaky, id);
});

test("a command its sandbox could not start fails as unrunnable (127), with bwrap's error, not as the command's exit 1", opts, async () => {
	const { wf } = await fixture();
	const e = await run(wf.haunted, {}).then(() => null, (x: unknown) => x);
	assert.ok(e instanceof NodeFailed);
	assert.ok(e.reason.type === "command_exited");
	assert.equal(e.reason.code, 127);
	assert.match(e.reason.stderr, /^the sandbox could not start the command: bwrap: execvp \/no\/such\/program/);
});

test("sessionOf types a turn-limited session by its agent, and refuses it as another agent's", opts, async () => {
	const { wf } = await fixture();
	faux.setResponses([() => fauxAssistantMessage([fauxToolCall("ls", {} as never)], { stopReason: "toolUse" }), () => fauxAssistantMessage([fauxToolCall("ls", {} as never)], { stopReason: "toolUse" }), () => fauxAssistantMessage([fauxToolCall("submit_result", { result: { ok: true } } as never)], { stopReason: "toolUse" })]);
	const r = await run(wf.continued, {});
	assert.equal(r.output.ok, true);
	assert.match(r.output.refused, /this session is not a session of other \(wf\.ts:\d+\)/);
});

test("an envelope's from goes into an agent's Address(T) input; the runtime checks its schema at call start", opts, async () => {
	const { wf } = await fixture();
	faux.setResponses([() => fauxAssistantMessage([fauxToolCall("send", { to: "to", message: "hi back" } as never)], { stopReason: "toolUse" }), () => fauxAssistantMessage([fauxToolCall("submit_result", { result: { ok: true } } as never)], { stopReason: "toolUse" })]);
	assert.deepEqual((await run(wf.relayed, { numbers: false })).output, { heard: "hi back" });
	await assert.rejects(run(wf.relayed, { numbers: true }), (e: unknown) => e instanceof NodeFailed && /takes another message schema than this input declares/.test(e.message));
});
