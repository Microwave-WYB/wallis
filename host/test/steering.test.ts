// The inbox of a node: send (answer or steer), interrupt and restart, plus pause and
// cancel --node. Each needs its capability; steering changes only the
// node's eventual output, which is journaled, so replay stays deterministic.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Executor, NodeSession, NodeSpec, TurnResult } from "../src/host/executor.ts";
import { appendInbox, EventLog, FakeCommands, IdleNode, LiveNode, OwnedRun, runPaths, runWorkflow, type Session, startSession, SteerableNode } from "../src/host/index.ts";
import { refusedEntry } from "../src/host/store.ts";
import { inspectRun, nodeTranscript, renderTree, runLog } from "../src/host/query.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const twoNode = resolve(here, "../examples/two-node/workflow.ts");
const fanout = resolve(here, "fixtures/fanout/workflow.ts");

/** The planner's turn waits until it is steered, interrupted or continued; the writer submits at once. */
class Gated implements Executor {
	readonly id = "gated";
	readonly open = new Map<string, (r: TurnResult) => void>();
	readonly specs: NodeSpec[] = [];

	start(spec: NodeSpec): NodeSession {
		this.specs.push(spec);
		const planned = (outline: string): TurnResult => ({ type: "submitted", output: { outline: [outline], note: `planned ${outline}` } });
		let resolveTurn: ((r: TurnResult) => void) | null = null;
		return {
			turn: (message) => {
				if (spec.agent === "writer") return Promise.resolve({ type: "submitted", output: { text: "t", words: 1 } });
				if (message !== undefined) return Promise.resolve(planned(message));
				if (spec.note !== null) return Promise.resolve(planned(`note: ${spec.note}`));
				return new Promise<TurnResult>((r) => {
					resolveTurn = r;
					this.open.set(spec.id, r);
				});
			},
			steer: (text) => resolveTurn?.(planned(text)),
			interrupt: () => resolveTurn?.({ type: "interrupted" }),
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

/** The human's capabilities against the live run. */
function owned(session: Session): OwnedRun {
	const o = session.owned("human");
	assert.ok(o instanceof OwnedRun);
	return o;
}

function steerable(session: Session, id: string): SteerableNode {
	const n = SteerableNode.check(owned(session), id);
	assert.ok(n instanceof SteerableNode, JSON.stringify(n));
	return n;
}

function live(session: Session, id: string): LiveNode {
	const n = LiveNode.check(owned(session), id);
	assert.ok(n instanceof LiveNode, JSON.stringify(n));
	return n;
}

test("steer a running node: only its output is journaled; replay after a kill is identical", async () => {
	const root = tmp();
	const dir = join(root, "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" }, seed: 5 });
	await untilOpen(gated, "#0");
	assert.equal(session.steer(steerable(session, "#0"), "go left"), null);
	const result = await session.result;
	assert.equal(result.outcome?.type, "done");
	assert.equal((result.outcome as unknown as { value: { note: string } }).value.note, "planned go left");
	const log = new EventLog(join(dir, "log.jsonl")).read();
	const at = log.findIndex((e) => e.type === "steered");
	assert.ok(at > 0);
	assert.deepEqual(log[at], { type: "steered", node: "#0", text: "go left", message_id: (log[at] as { message_id: string }).message_id, by: "human" });
	// The node's journal entry records the message and its step.
	const node = result.run.nodes[0]!;
	assert.deepEqual("inbox" in node && node.inbox, [{ kind: "steer", text: "go left", step: 0 }]);

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
	assert.match(renderTree(inspectRun(dir)), /#0  planner  fake\/default  done \(submitted\)  inbox: steer@0/);
	assert.match(renderTree(inspectRun(dir)), /~0  observe outline = \["go left"\]/);
	assert.equal(runLog(dir, 0, 2).items.length, 2);
	assert.equal(runLog(dir, 0, 2).next, 2);
});

test("interrupt aborts the turn: the node goes Idle(interrupted), progress kept; a message continues it", async () => {
	const dir = join(tmp(), "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" } });
	await untilOpen(gated, "#0");
	assert.equal(session.interrupt(steerable(session, "#0")), null);
	const idle = await session.result;
	const node = idle.run.nodes[0]!;
	assert.deepEqual(node.type === "node_idle" && node.cause, { type: "interrupted" });
	// Interrupt and redirect: the message is delivered to the idle node.
	const result = await runWorkflow({ ...base(dir, gated), sends: [{ node: "#0", text: "go right" }] });
	assert.equal(result.outcome?.type, "done");
	assert.equal((result.outcome as unknown as { value: { note: string } }).value.note, "planned go right");
	const types = new EventLog(join(dir, "log.jsonl")).read().map((e) => e.type);
	assert.deepEqual(types.slice(types.indexOf("interrupt_requested"), types.indexOf("interrupt_requested") + 4), ["interrupt_requested", "turn_interrupted", "sent", "agent_returned"]);
	const done = result.run.nodes[0]!;
	assert.deepEqual("inbox" in done && done.inbox.map((m) => m.kind), ["interrupt", "answer"]);
});

test("send reports how it was delivered: a steer to a running node, a reply to an idle one", async () => {
	const dir = join(tmp(), "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" } });
	await untilOpen(gated, "#0");
	// More turns go only to an idle node: with a running one they are refused, not ignored.
	assert.deepEqual(session.send(owned(session), "#0", "go left", "m0", 2), { refusal: { type: "not_idle", node: "#0" } });
	assert.deepEqual(session.send(owned(session), "#0", "go left", "m1"), { delivered: "steer" });
	await session.result;
	const { deliveryOf } = await import("../src/host/query.ts");
	assert.equal(deliveryOf(dir, "m1"), "queued as steer after the current turn of #0");
});

test("restart discards progress and reissues the call with its input and the note; a stale turn is discarded", async () => {
	const dir = join(tmp(), "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" } });
	await untilOpen(gated, "#0");
	const stale = gated.open.get("#0")!;
	assert.equal(session.restart(live(session, "#0"), "be brief"), null);
	// The first session's turn finishes late: it must not count.
	stale({ type: "submitted", output: { outline: ["old"], note: "old" } });
	const result = await session.result;
	assert.equal((result.outcome as unknown as { value: { note: string } }).value.note, "planned note: be brief");
	assert.deepEqual(gated.specs.filter((s) => s.agent === "planner").map((s) => [s.note, s.input]), [
		[null, { topic: "x" }],
		["be brief", { topic: "x" }],
	]);
	const log = new EventLog(join(dir, "log.jsonl")).read();
	assert.ok(log.some((e) => e.type === "restarted" && e.note === "be brief"));
	assert.equal(log.filter((e) => e.type === "agent_returned").length, 2, "planner once (after the restart), writer once");
	assert.match(nodeTranscript(dir, "#0").items.map((e) => e.entry).join("\n"), /discarded the (ended|submitted|interrupted) turn of a call that was restarted/);
});

test("a non-steerable node accepts only cancel and a restart without a note", async () => {
	const dir = join(tmp(), "run");
	const { FakeExecutor } = await import("../src/host/index.ts");
	let judged = 0;
	const executor = new FakeExecutor({
		scout: (call) => ({ output: { errors: [`E-${(call.input as { area: string }).area}`] } }),
		judge: () => (judged++ === 0 ? { idle: "May I see more?" } : { output: { findings: [] } }),
		merger: { output: { items: [], archived: [] } },
		attempt: { output: { ok: true } },
	});
	const session = await startSession({ workflow: fanout, dir, executor, input: null, inboxPollMs: null });
	await session.result;
	const view = inspectRun(dir);
	const judge = view.run.nodes.find((n) => "agent" in n && n.agent === "judge")!;
	assert.equal(judge.type, "node_idle");
	assert.equal(judge.steerable, false);
	const o = OwnedRun.check(view.run, "human");
	assert.ok(o instanceof OwnedRun);
	assert.deepEqual(IdleNode.check(o, judge.id), { type: "not_steerable", node: judge.id });
	// The CLI prints how to act on it instead of how to answer.
	const { attention, describe } = await import("../src/host/query.ts");
	assert.match(describe(attention(view)), /not steerable: it takes no messages; restart or cancel it/);
	// A restart without a note reissues the call.
	const again = await runWorkflow({ workflow: fanout, dir, executor, inboxPollMs: null });
	assert.equal(again.status.type, "idle", "unchanged without an intervention");
	// A run no session drives takes interventions from its inbox; the core re-checks them.
	const paths = runPaths(dir);
	appendInbox(paths, { id: "r1", type: "restart", node: judge.id, note: "a hint", by: "human" });
	appendInbox(paths, { id: "r2", type: "restart", node: judge.id, by: "human" });
	const commands = new FakeCommands({ train: { stdout: JSON.stringify({ budget: null }) } });
	const done = await runWorkflow({ workflow: fanout, dir, executor, commands, confine: "off", inboxPollMs: null });
	assert.deepEqual(refusedEntry(paths, "r1"), { type: "not_steerable", node: judge.id });
	assert.equal(refusedEntry(paths, "r2"), null);
	assert.equal(done.outcome?.type, "done", JSON.stringify(done.status));
	const log = new EventLog(join(dir, "log.jsonl")).read();
	assert.deepEqual(log.filter((e) => e.type === "restarted"), [{ type: "restarted", node: judge.id, note: null, by: "human", turns: 0 }]);
});

test("pause issues no new calls (Idle(PausedByUser)); resume continues", async () => {
	const dir = join(tmp(), "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" } });
	await untilOpen(gated, "#0");
	session.pause(owned(session));
	gated.open.get("#0")!({ type: "submitted", output: { outline: ["a"], note: "n" } });
	const paused = await session.result;
	assert.deepEqual(paused.status, { type: "idle", reason: { type: "paused_by_user" } });
	assert.deepEqual(paused.run.nodes.map((n) => [n.type, "agent" in n ? n.agent : ""]), [["node_done", "planner"], ["node_held", "writer"]], "the writer is held back, not issued");
	// A held-back call is live: the host's check lets the owner cancel it, as the core does.
	const o = OwnedRun.check(paused.run, "human");
	assert.ok(o instanceof OwnedRun && LiveNode.check(o, "#1") instanceof LiveNode);
	const done = await runWorkflow({ ...base(dir, new Gated()), unpause: true });
	assert.equal(done.outcome?.type, "done");
});

test("cancel --node fails that node as a typed agent failure for the body", async () => {
	const dir = join(tmp(), "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" } });
	await untilOpen(gated, "#0");
	assert.equal(session.cancelNode(live(session, "#0")), null);
	const result = await session.result;
	assert.deepEqual(result.outcome, { type: "failed", reason: { type: "agent_gave_up", agent: "planner", failure: { type: "cancelled_by_owner" } } });
});

test("interventions need the owner: another caller is refused, typed", async () => {
	const dir = join(tmp(), "run");
	const gated = new Gated();
	const session = await startSession({ ...base(dir, gated), input: { topic: "x" }, owner: "harness:a" });
	await untilOpen(gated, "#0");
	assert.deepEqual(session.owned("harness:b"), { type: "not_owner", by: "harness:b", owner: "harness:a" });
	const mine = session.owned("harness:a");
	assert.ok(mine instanceof OwnedRun);
	assert.deepEqual(SteerableNode.check(mine, "#1"), { type: "node_not_running", node: "#1" });
	session.cancel(mine);
	assert.equal((await session.result).outcome?.type, "cancelled");
});

test("an interrupt made while a restarted call starts reaches that call, not the attempt it replaced", async () => {
	// Every start waits until the test lets it open; every turn waits until interrupted.
	const starts: { id: string; open: () => void; interrupted: boolean }[] = [];
	const executor: Executor = {
		id: "slow-start",
		start: (spec) =>
			new Promise<NodeSession>((resolveStart) => {
				const entry = { id: spec.id, interrupted: false, open: () => {} };
				let endTurn: ((r: TurnResult) => void) | null = null;
				entry.open = () =>
					resolveStart({
						// An interrupt before the turn ends it as it starts.
						turn: () => (entry.interrupted ? Promise.resolve<TurnResult>({ type: "interrupted" }) : new Promise<TurnResult>((r) => (endTurn = r))),
						interrupt: () => {
							entry.interrupted = true;
							endTurn?.({ type: "interrupted" });
						},
						handle: () => ({ start: spec.id }),
						close: () => {},
					});
				starts.push(entry);
			}),
	};
	const dir = join(tmp(), "run");
	const session = await startSession({ workflow: twoNode, dir, executor, inboxPollMs: null, input: { topic: "x" } });
	const started = async (n: number) => {
		for (let i = 0; i < 200 && starts.length < n; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(starts.length, n);
	};
	await started(1);
	assert.equal(session.restart(live(session, "#0")), null);
	await started(2);
	assert.equal(session.interrupt(steerable(session, "#0")), null);
	// The replaced attempt opens late: it must neither take the interrupt nor become the node's session.
	starts[0]!.open();
	await new Promise((r) => setTimeout(r, 20));
	starts[1]!.open();
	for (let i = 0; i < 200 && !starts[1]!.interrupted; i++) await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(
		starts.map((s) => s.interrupted),
		[false, true],
	);
	const planner = () => inspectRun(dir).run.nodes.find((n) => n.id === "#0")!;
	for (let i = 0; i < 200 && planner().type !== "node_idle"; i++) await new Promise((r) => setTimeout(r, 10));
	const node = planner();
	assert.deepEqual(node.type === "node_idle" && node.cause, { type: "interrupted" }, JSON.stringify(node));
	session.cancel(owned(session));
	await session.result;
});
