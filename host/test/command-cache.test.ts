// A command's cache key is what it runs (the argv `run` computes, the
// sandbox), not its code's text: a constant its `run` reads is part of it.
// The journal keeps the process result; the current `parse` is applied on
// every delivery, so a `parse` change needs no rerun and is never stale.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FakeCommands, FakeExecutor, forkRun, runWorkflow } from "../src/host/index.ts";
import { tmp } from "./util.ts";

const workflowText = (flag: string, factor: number) => `import { command, defineModels, defineSandbox, Type, workflow } from "wallis";
const FLAG = "${flag}";
const FACTOR = ${factor};
const box = defineSandbox({}, { name: "box", requires: ["sh"] });
const tool = command({ name: "tool", sandbox: box, input: Type.Object({ n: Type.Number() }), output: Type.Object({ v: Type.Number() }),
	run: (i) => ["sh", "-c", "echo", FLAG, String(i.n)],
	parse: (r, i) => ({ v: Number(r.stdout.trim()) * FACTOR + i.n }) });
export default workflow({ name: "cc", models: defineModels({ default: "fake/default" }), agents: [], commands: [tool], input: Type.Null(), output: Type.Any(),
	run: async (ctx) => ctx.call(tool, { n: 1 }) });
`;

test("a changed constant in run re-executes the command; a changed parse is applied without a rerun; a parse that rejects the result reruns it", async () => {
	const root = tmp("wallis-cc-");
	const wf = join(root, "wf");
	mkdirSync(wf);
	const file = join(wf, "workflow.ts");
	writeFileSync(file, workflowText("--old", 1));
	const base = { confine: "off", inboxPollMs: null, bins: { sh: "/bin/sh" }, workflow: file, executor: new FakeExecutor({}) } as const;
	const commands = () => new FakeCommands({ tool: { stdout: "10\n" } });
	const dir = join(root, "r1");
	const first = commands();
	const done = await runWorkflow({ ...base, dir, input: null, commands: first });
	assert.deepEqual(done.outcome, { type: "done", value: { v: 11 } });
	// The reviewer's repro: a constant `run` reads changes; a fork must run the command again.
	writeFileSync(file, workflowText("--new", 1));
	const flagged = commands();
	const forkA = forkRun(dir, join(root, "r2"));
	await runWorkflow({ ...base, dir: forkA.dir, commands: flagged });
	assert.deepEqual(flagged.calls.map((c) => c.argv), [["sh", "-c", "echo", "--new", "1"]]);
	// A constant only `parse` reads changes: no rerun, and the new parse is applied to the journaled result.
	writeFileSync(file, workflowText("--old", 3));
	const parsedOnly = commands();
	const forkB = forkRun(dir, join(root, "r3"));
	const reparsed = await runWorkflow({ ...base, dir: forkB.dir, commands: parsedOnly });
	assert.equal(parsedOnly.calls.length, 0);
	assert.deepEqual(reparsed.outcome, { type: "done", value: { v: 31 } });
	// A parse that no longer accepts the journaled result: the call runs again.
	writeFileSync(file, workflowText("--old", 1).replace("Number(r.stdout.trim()) * FACTOR + i.n", "(() => { if (!r.stdout.startsWith('v=')) throw new Error('want v='); return Number(r.stdout.slice(2)) + i.n; })()"));
	const rerun = new FakeCommands({ tool: { stdout: "v=5" } });
	const forkC = forkRun(dir, join(root, "r4"));
	const again = await runWorkflow({ ...base, dir: forkC.dir, commands: rerun });
	assert.equal(rerun.calls.length, 1);
	assert.deepEqual(again.outcome, { type: "done", value: { v: 6 } });
});
