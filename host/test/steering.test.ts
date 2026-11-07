// Steering a running node (send), interrupt, pause/resume and cancel --node.
// Steering only changes the node's eventual output, which is journaled, so
// replay stays deterministic.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Executor, NodeSession, NodeSpec, TurnResult } from "../src/host/executor.ts";
import { EventLog, runWorkflow, startSession } from "../src/host/index.ts";
import { nodeTranscript, renderTree, runLog } from "../src/host/query.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const twoNode = resolve(here, "../examples/two-node/workflow.ts");

/** The planner's turn waits until it is steered, interrupted or continued; the writer submits at once. */
class Gated implements Executor {
	readonly id = "gated";
	readonly open = new Map<string, (r: TurnResult) => void>();

	start(spec: NodeSpec): NodeSession {
		const planned = (outline: string): TurnResult => ({ type: "submitted", output: { outline: [outline], note: `planned ${outline}` } });
		let resolveTurn: ((r: TurnResult) => void) | null = null;
		return {
			turn: (message) => {
				if (spec.agent === "writer") return Promise.resolve({ type: "submitted", output: { text: "t", words: 1 } });
				if (message !== undefined) return Promise.resolve(planned(message));
				return new Promise<TurnResult>((r) => {
					resolveTurn = r;
					this.open.set(spec.id, r);
				});
			},
			steer: (text) => resolveTurn?.(planned(text)),
			interrupt: () => resolveTurn?.({ type: "ended", message: "(interrupted)" }),
			handle: () => ({ gated: spec.id }),
			close: () => {},
		};
	}
}

async function untilOpen(gated: Gated, id: string): Promise<void> {
	for (let i = 0; i < 200 && !gated.open.has(id); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(gated.open.has(id), `node ${id} is running`);
}

const base = (dir: string, gated: Gated) => ({ workflow: twoNode, dir, executor: gated, inboxPollMs: null }) as const;

test("send to a running node steers it; only its output is journaled; replay after a kill is identical", async () => {
	const root = tmp();
	const dir = join(root, "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" }, seed: 5 });
	await untilOpen(gated, "#0");
	assert.equal(session.send("#0", "go left"), null);
	const result = await session.result;
	assert.equal(result.outcome?.type, "done");
	assert.deepEqual(result.run.state.notes, ["planned go left", (result.run.state.notes as string[])[1]]);
	const log = new EventLog(join(dir, "log.jsonl")).read();
	const at = log.findIndex((e) => e.type === "steered");
	assert.ok(at > 0);
	assert.equal((log[at] as { text: string }).text, "go left");

	// Killed right after the steer was logged: the resumed run reissues the
	// node with the message and ends in the same state, with the same log.
	const cut = join(root, "cut");
	mkdirSync(cut);
	writeFileSync(join(cut, "log.jsonl"), log.slice(0, at + 1).map((e) => `${JSON.stringify(e)}\n`).join(""));
	const resumed = await runWorkflow(base(cut, new Gated()));
	assert.equal(resumed.snapshot, result.snapshot);
	assert.equal(readFileSync(join(cut, "log.jsonl"), "utf8"), readFileSync(join(dir, "log.jsonl"), "utf8"));
	// The transcript records the steer; monitoring sees the tree and the log.
	assert.match(nodeTranscript(dir, "#0").items.map((e) => e.entry).join("\n"), /\[steer\] go left/);
	assert.match(renderTree((await import("../src/host/query.ts")).inspectRun(dir)), /#0  planner  fake\/default  done \(submitted\)/);
	assert.equal(runLog(dir, 0, 2).items.length, 2);
	assert.equal(runLog(dir, 0, 2).next, 2);
});

test("interrupt aborts the turn, then the message continues the node", async () => {
	const dir = join(tmp(), "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" } });
	await untilOpen(gated, "#0");
	assert.equal(session.interrupt("#0", "go right"), null);
	const result = await session.result;
	assert.equal(result.outcome?.type, "done");
	assert.equal((result.run.state.notes as string[])[0], "planned go right");
	const types = new EventLog(join(dir, "log.jsonl")).read().map((e) => e.type);
	assert.deepEqual(types.slice(types.indexOf("interrupted"), types.indexOf("interrupted") + 4), ["interrupted", "agent_idle", "sent", "agent_returned"]);
});

test("pause issues no new calls (Idle(PausedByUser)); resume continues", async () => {
	const dir = join(tmp(), "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" } });
	await untilOpen(gated, "#0");
	session.pause();
	gated.open.get("#0")!({ type: "submitted", output: { outline: ["a"], note: "n" } });
	const paused = await session.result;
	assert.deepEqual(paused.status, { type: "idle", reason: { type: "paused_by_user" } });
	assert.deepEqual(paused.run.nodes.map((n) => n.agent), ["planner"], "the writer was not issued");
	const done = await runWorkflow({ ...base(dir, new Gated()), unpause: true });
	assert.equal(done.outcome?.type, "done");
});

test("cancel --node fails that node as an agent failure for the body", async () => {
	const dir = join(tmp(), "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" } });
	await untilOpen(gated, "#0");
	assert.equal(session.cancelNode("#0"), null);
	const result = await session.result;
	assert.deepEqual(result.outcome, { type: "failed", reason: { type: "agent_gave_up", agent: "planner", error: "cancelled by the owner" } });
});

