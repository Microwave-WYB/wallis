// The CLI end to end, with the fake executor module: questions and replies,
// SIGKILL and the derived `stopped`, alias rebinds, executor errors, forks,
// cancel and pending.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeExecutor, lines, logOf, normalized, onlyRun, project, runDir, tmp, wallis } from "./util.ts";

const ask = ["run", "ask", "--input", '{"topic":"folds"}', "--seed", "7", "--executor", fakeExecutor];

function status(root: string, id: string) {
	const r = wallis(root, ["status", id, "--json"]);
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout) as { status: { type: string; reason?: unknown; outcome?: { type: string } }; stopped: boolean; nodes: { id: string; agent: string; model: string; status: { type: string } }[] };
}

/** Runs `ask` until its question, replies, and waits for the end. */
function askAndReply(root: string, env: Record<string, string> = {}) {
	const started = wallis(root, ask);
	assert.equal(started.status, 0, started.stderr);
	const id = onlyRun(root);
	const sent = wallis(root, ["send", id, "#0", "newcomers"], env);
	assert.equal(sent.status, 0, sent.stderr + sent.stdout);
	const waited = wallis(root, ["wait", id, "--timeout", "30"]);
	return { id, started, waited };
}

test("a node asks, the run idles, a reply continues the same conversation", () => {
	const root = project();
	const execLog = join(tmp(), "exec.jsonl");
	const started = wallis(root, ask, { WALLIS_FAKE_EXEC_LOG: execLog });
	assert.equal(started.status, 0, started.stderr);
	assert.match(started.stdout, /node #0 \(scout\) asks:\n  > Who is the audience: experts or newcomers\?/);
	assert.match(started.stdout, /npx wallis send .* '#0' "<message>"/);
	const id = onlyRun(root);
	assert.deepEqual(status(root, id).status, { type: "idle", reason: null });
	assert.equal(status(root, id).stopped, true, "an idle run with no driver is resumable");

	// pending lists the question; an empty project prints nothing.
	assert.match(wallis(root, ["pending"]).stdout, /Who is the audience/);
	assert.equal(wallis(project(), ["pending"]).stdout, "");

	// Sending to a node that is not idle is refused.
	const refused = wallis(root, ["send", id, "#1", "hello"]);
	assert.equal(refused.status, 1);
	assert.match(refused.stdout, /not_idle/);

	assert.equal(wallis(root, ["send", id, "#0", "newcomers"], { WALLIS_FAKE_EXEC_LOG: execLog }).status, 0);
	const waited = wallis(root, ["wait", id, "--timeout", "30"]);
	assert.equal(waited.status, 0, waited.stderr);
	assert.match(waited.stdout, /finished, done/);
	assert.equal(status(root, id).status.type, "finished");
	assert.equal(wallis(root, ["pending"]).stdout, "");
	// Monitoring.
	assert.match(wallis(root, ["ls"]).stdout, new RegExp(`${id}  ask  finished \\(done\\)`));
	assert.match(wallis(root, ["tree", id]).stdout, /#0  scout/);
	assert.match(wallis(root, ["log", id, "--since", "1", "--limit", "1"]).stdout, /^1\t\{"type":"noted","key":"workflow"/);
	assert.match(wallis(root, ["log", id, "--follow"]).stdout, /"type":"body_finished"/);
	assert.match(wallis(root, ["show", id, "#0"]).stdout, /"kind":"user","text":"newcomers"/);

	const log = logOf(root, id);
	const sentEvents = log.filter((e) => e.type === "sent");
	assert.equal(sentEvents.length, 1);
	assert.deepEqual({ ...sentEvents[0], message_id: "<id>" }, { type: "sent", node: "#0", text: "newcomers", message_id: "<id>", by: sentEvents[0]!.by, turns: 0 });
	assert.match(String(sentEvents[0]!.by), /^(human|harness:.+)$/, "the sender's identity is logged");
	assert.ok(log.some((e) => e.type === "agent_asked" && e.message === "Who is the audience: experts or newcomers?"));
	// The idle turn was not replayed: the reply continued the conversation.
	assert.deepEqual(lines(execLog).map((e) => [e.agent, e.replies]), [["scout", 0], ["scout", 1], ["writer", 0]]);
});

test("killed while answering: the run is stopped, resumes, and its log equals an uninterrupted one", () => {
	const reference = project();
	const { id: refId } = askAndReply(reference);
	const expected = logOf(reference, refId);

	const root = project();
	const execLog = join(tmp(), "exec.jsonl");
	const started = wallis(root, ask, { WALLIS_FAKE_EXEC_LOG: execLog });
	assert.equal(started.status, 0, started.stderr);
	const id = onlyRun(root);
	// The detached driver dies while the continued scout call is in flight.
	assert.equal(wallis(root, ["send", id, "#0", "newcomers"], { WALLIS_FAKE_EXEC_LOG: execLog, WALLIS_FAKE_KILL_ON: "scout:1" }).status, 0);
	const waited = wallis(root, ["wait", id, "--timeout", "30"]);
	assert.match(waited.stdout, /stopped: no process drives it/);
	const stopped = status(root, id);
	assert.equal(stopped.stopped, true);
	assert.equal(stopped.status.type, "running");
	assert.ok(!JSON.stringify(logOf(root, id)).includes('"stopped"'), "stopped is derived, never logged");

	const resumed = wallis(root, ["resume", id], { WALLIS_FAKE_EXEC_LOG: execLog });
	assert.equal(resumed.status, 0, resumed.stderr);
	assert.match(resumed.stdout, /finished, done/);
	assert.deepEqual(normalized(logOf(root, id)), normalized(expected));
	// The idle first turn ran once; the continued turn ran again only because it was cut off.
	assert.deepEqual(lines(execLog).map((e) => [e.agent, e.replies]), [["scout", 0], ["scout", 1], ["scout", 1], ["writer", 0]]);
});

test("an alias rebind on resume re-executes no completed call and records the model per call", () => {
	const root = project();
	const execLog = join(tmp(), "exec.jsonl");
	const run = wallis(root, ["run", "two-node", "--input", '{"topic":"x"}', "--executor", fakeExecutor], {
		WALLIS_FAKE_EXEC_LOG: execLog,
		WALLIS_FAKE_KILL_ON: "writer",
	});
	assert.equal(run.signal, "SIGKILL");
	const id = onlyRun(root);
	assert.equal(status(root, id).stopped, true);

	const resumed = wallis(root, ["resume", id, "--model", "writer=other/model"], { WALLIS_FAKE_EXEC_LOG: execLog });
	assert.equal(resumed.status, 0, resumed.stderr);
	const s = status(root, id);
	assert.equal(s.status.type, "finished");
	assert.deepEqual(s.nodes.map((n) => [n.id, n.agent, n.model]), [["#0", "planner", "fake/default"], ["#1", "writer", "other/model"]]);
	assert.deepEqual(lines(execLog).map((e) => [e.agent, e.model]), [["planner", "fake/default"], ["writer", "fake/default"], ["writer", "other/model"]]);
	const log = logOf(root, id);
	assert.deepEqual(log.find((e) => e.type === "alias_rebound"), { type: "alias_rebound", alias: "writer", from: "fake/default", to: "other/model" });
	assert.deepEqual(log.filter((e) => e.type === "agent_returned").map((e) => e.model), ["fake/default", "other/model"]);
});

test("an executor error pauses the run; a rebind and resume reissue the call", () => {
	const root = project();
	const execLog = join(tmp(), "exec.jsonl");
	const env = { WALLIS_FAKE_EXEC_LOG: execLog, WALLIS_FAKE_UNAVAILABLE_MODEL: "bad/model" };
	const run = wallis(root, ["run", "two-node", "--input", '{"topic":"x"}', "--model", "writer=bad/model", "--executor", fakeExecutor], env);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /paused: the executor cannot serve model alias writer: HTTP 412 account suspended/);
	const id = onlyRun(root);
	assert.deepEqual(status(root, id).status, { type: "idle", reason: { type: "executor_unavailable", alias: "writer", error: "HTTP 412 account suspended" } });
	assert.ok(!logOf(root, id).some((e) => e.type === "agent_failed"), "not an agent failure");

	// Resuming without a fix tries again and pauses again.
	assert.match(wallis(root, ["resume", id], env).stdout, /paused/);
	const fixed = wallis(root, ["resume", id, "--model", "writer=good/model"], env);
	assert.equal(fixed.status, 0, fixed.stderr);
	assert.equal(status(root, id).status.type, "finished");
	assert.deepEqual(lines(execLog).map((e) => [e.agent, e.model]), [["planner", "fake/default"], ["writer", "bad/model"], ["writer", "bad/model"], ["writer", "good/model"]]);
	const types = logOf(root, id).map((e) => e.type);
	assert.deepEqual(types.slice(types.indexOf("executor_failed")), ["executor_failed", "retry_unavailable", "executor_failed", "alias_rebound", "retry_unavailable", "agent_returned", "observed", "body_finished"]);
});

test("fork copies the journal (a cache): the fork re-executes and every unchanged call hits; the original is untouched", () => {
	const root = project();
	const { id } = askAndReply(root);
	const original = readFileSync(join(runDir(root, id), "log.jsonl"), "utf8");
	const execLog = join(tmp(), "exec.jsonl");
	writeFileSync(execLog, "");
	const forked = wallis(root, ["fork", id, "--model", "writer=forked/model"], { WALLIS_FAKE_EXEC_LOG: execLog });
	assert.equal(forked.status, 0, forked.stderr);
	const forkId = /into (\S+)\./.exec(forked.stdout)![1]!;
	assert.notEqual(forkId, id);
	assert.equal(readFileSync(join(runDir(root, id), "log.jsonl"), "utf8"), original);
	// Nothing ran again: every call hit the copied journal, and the fork finished the same way.
	assert.equal(readFileSync(execLog, "utf8"), "");
	assert.deepEqual(status(root, forkId).status, status(root, id).status);
	const child = logOf(root, forkId);
	assert.ok(child.some((e) => e.type === "claimed"), "the fork is owned by whoever forked it");
	assert.deepEqual(child.find((e) => e.type === "alias_rebound"), { type: "alias_rebound", alias: "writer", from: "fake/default", to: "forked/model" });
	assert.equal(wallis(root, ["fork", id, "--at", "3"]).status, 1, "--at is gone: positions do not matter");
});

test("fork --forget: the forgotten call executes again; the rest hit; an unknown node is refused", () => {
	const root = project();
	const { id } = askAndReply(root);
	const execLog = join(tmp(), "exec.jsonl");
	writeFileSync(execLog, "");
	const forked = wallis(root, ["fork", id, "--forget", "#0"], { WALLIS_FAKE_EXEC_LOG: execLog });
	assert.equal(forked.status, 0, forked.stderr);
	assert.match(forked.stdout, /forgetting #0/);
	const forkId = /into (\S+),/.exec(forked.stdout)![1]!;
	assert.deepEqual(lines(execLog).map((e) => e.agent), ["scout"], "only the forgotten call ran again");
	// Executed again, the scout asks its question again: the fork waits for the answer.
	assert.deepEqual(status(root, forkId).status, { type: "idle", reason: null });
	const refused = wallis(root, ["fork", id, "--forget", "#99"]);
	assert.equal(refused.status, 1);
	assert.match(refused.stdout, /Refused: \{"type":"not_live","node":"#99"\}/);
});

test("cancel finishes an idle run as cancelled", () => {
	const root = project();
	assert.equal(wallis(root, ask).status, 0);
	const id = onlyRun(root);
	const cancelled = wallis(root, ["cancel", id]);
	assert.equal(cancelled.status, 0, cancelled.stderr);
	assert.match(cancelled.stdout, /finished, cancelled/);
	assert.deepEqual(status(root, id).status, { type: "finished", outcome: { type: "cancelled" } });
	assert.equal(logOf(root, id).at(-1)!.type, "cancel_requested");
	assert.equal(wallis(root, ["pending"]).stdout, "");
});
