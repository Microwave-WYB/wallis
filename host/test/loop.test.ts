// ctx.loop: a typed fold whose iterations are deterministic branches
// (`<loop>.<i>`), shown by the runtime (tree, status), stable on replay,
// fork and resume.

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendInbox, FakeExecutor, runPaths, runWorkflow } from "../src/host/index.ts";
import { forkRun, inspectRun, latestObservations, renderTree } from "../src/host/query.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const workflow = resolve(here, "fixtures/loop/workflow.ts");

/** Warmth falls by one each round from 4; it gives up once at `failAt` (until restarted). */
function colorist(calls: string[], failAt?: number) {
	let failed = false;
	return new FakeExecutor({
		colorist: (call) => {
			const { round } = call.input as { round: number };
			calls.push(call.id);
			if (round === failAt && !failed) {
				failed = true;
				return { giveUp: "the sheet would not load" };
			}
			return { submit: { look: `look ${round}`, warmth: 4 - round } };
		},
	});
}

const opts = (dir: string) => ({ workflow, dir, confine: "off" as const, inboxPollMs: null });

test("a loop over a session goes round until done; each iteration calls the session the previous one left", async () => {
	const dir = join(tmp(), "run");
	const calls: string[] = [];
	const r = await runWorkflow({ ...opts(dir), input: { max: 10 }, executor: colorist(calls) });
	assert.deepEqual(r.outcome, { type: "done", value: { ending: "approved", look: "look 3", rounds: 4 } });
	// Iteration i is branch #0.<i>; its call is its first request.
	assert.deepEqual(calls, ["#0.0#0", "#0.1#0", "#0.2#0", "#0.3#0"]);
	// One session lineage: each call continues the value the call before it answered with.
	const sessions = r.run.sessions;
	for (let i = 1; i < 4; i++) assert.equal(sessions.find((s) => s.call === `#0.${i}#0`)!.from, sessions.find((s) => s.call === `#0.${i - 1}#0`)!.id);
	const other = await runWorkflow({ ...opts(join(tmp(), "run")), input: { max: 2 }, executor: colorist([]) });
	assert.deepEqual(other.outcome, { type: "done", value: { ending: "abandoned", rounds: 2 } });
});

test("replay and fork give identical iterations: every call a hit, the same ids and observations", async () => {
	const dir = join(tmp(), "run");
	const first = await runWorkflow({ ...opts(dir), input: { max: 10 }, executor: colorist([]) });
	const again: string[] = [];
	const replayed = await runWorkflow({ ...opts(dir), executor: colorist(again) });
	assert.equal(replayed.snapshot, first.snapshot);
	const fork = forkRun(dir, join(tmp(), "fork"));
	const forked = await runWorkflow({ ...opts(fork.dir), executor: colorist(again) });
	assert.deepEqual(forked.outcome, first.outcome);
	assert.deepEqual(forked.run.observations, first.run.observations);
	assert.deepEqual(again, [], "nothing was called again");
});

test("a node failure in iteration 2 is held; its restart recomputes from there, iterations 0 and 1 hit", async () => {
	const dir = join(tmp(), "run");
	const calls: string[] = [];
	const executor = colorist(calls, 2);
	const held = await runWorkflow({ ...opts(dir), input: { max: 10 }, executor });
	assert.deepEqual(held.status, { type: "idle", reason: { type: "node_failure", node: "#0.2#0", reason: { type: "agent_gave_up", agent: "colorist", failure: { type: "gave_up", error: "the sheet would not load" } } } });
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: "#0.2#0", by: "human" });
	const done = await runWorkflow({ ...opts(dir), executor });
	assert.deepEqual(done.outcome, { type: "done", value: { ending: "approved", look: "look 3", rounds: 4 } });
	assert.deepEqual(calls, ["#0.0#0", "#0.1#0", "#0.2#0", "#0.2#0", "#0.3#0"]);
});

test("wallis tree shows the loop and its iterations with their state; status shows the current iteration", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ ...opts(dir), input: { max: 10 }, executor: colorist([], 2) });
	const running = inspectRun(dir);
	assert.match(renderTree(running), /\n {2}#0  loop  iteration 2 \(current\)\n/);
	assert.deepEqual((latestObservations(running)["loop #0"] as { iteration: number }).iteration, 2);
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: "#0.2#0", by: "human" });
	await runWorkflow({ ...opts(dir), executor: colorist([]) });
	const tree = renderTree(inspectRun(dir));
	assert.match(tree, /\n {2}#0  loop  done after 4 iterations\n/);
	assert.match(tree, /\n {4}#0\.1  iteration 1  state = \{"feedback":"too warm \(4\)","round":1,"session":\{"agent":"colorist","id":"s[0-9a-f]+"/);
	assert.match(tree, /\n {4}#0\.3  iteration 3  state = /);
});
