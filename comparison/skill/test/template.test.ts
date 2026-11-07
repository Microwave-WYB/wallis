// The template, copied into a fresh project dir and run end to end on the
// faux provider, with the Python harness in a real bwrap sandbox.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { call, error, faux, newest } from "./faux.ts";

const skill = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const bwrap = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--", "/bin/true"]).status === 0;
const python = existsSync("/usr/bin/python3");

/** A new project from the template (it owns the copy), sharing the skill's node_modules. */
function project(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-project-"));
	cpSync(join(skill, "template"), dir, { recursive: true });
	symlinkSync(join(skill, "node_modules"), join(dir, "node_modules"));
	process.chdir(dir);
	return dir;
}

test("the template's loop runs end to end; re-running is the resume", { skip: (!bwrap || !python) && "needs bwrap and /usr/bin/python3" }, async () => {
	const dir = project();
	const { main } = (await import(join(dir, "run.ts"))) as typeof import("../template/run.ts");
	let proposals = 0;
	const { models, seen } = faux((s) => {
		if (s.systemPrompt?.startsWith("You propose")) {
			// The first answer breaks the schema: the error goes back and the model retries.
			if (proposals++ === 0) return call("submit_result", { lr: 5, epochs: 20 });
			return call("submit_result", { lr: newest(s).includes("Invalid result") ? 0.02 : 0.01, epochs: 20 });
		}
		return call("submit_result", { advice: "lower the learning rate", stop: false });
	});
	const options = { task: "toy", iterations: 2, proposer: "faux/a", critic: "faux/b" };
	const out = await main(models, options);
	assert.equal(out.history.length, 2);
	assert.deepEqual(out.best, { lr: 0.01, epochs: 20, score: 1 });
	// The schema retry: the model saw the validation error and resubmitted (pi checks
	// the arguments against `parameters` before `execute`; the tool checks again).
	assert.ok(seen.some((s) => newest(s).includes("Validation failed for tool") && newest(s).includes("lr: expected <= 1")));
	// Every request ends with the turn quota on its newest message, never in the system prompt.
	for (const s of seen) {
		assert.match(newest(s), /\[Turn \d+ of \d+\]/);
		assert.doesNotMatch(s.systemPrompt ?? "", /Turn \d+ of/);
	}
	// Memory is pushed in: the second proposer saw the first trial and the critic's advice.
	assert.ok(seen.some((s) => s.systemPrompt?.startsWith("You propose") && newest(s).includes("lower the learning rate")));
	assert.ok(existsSync(join(dir, "work/iter-0/eval/output.json")), "the harness ran in the sandbox and wrote its output");
	assert.ok(existsSync(join(dir, "work/iter-0/propose.session.json")));

	// Re-running: every step's file exists, so nothing runs again.
	const before = seen.length;
	const again = await main(models, options);
	assert.deepEqual(again, out);
	assert.equal(seen.length, before, "no model request on the resume");
});

test("a copied template type-checks on its own", () => {
	const dir = project();
	const r = spawnSync(process.execPath, [join(skill, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", dir], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("an agent continues from its checkpoint after a crash; transient errors retry; others do not", async () => {
	project();
	const { runAgent, AgentError } = await import("../template/lib/agent.ts");
	const noop = { name: "note", label: "note", description: "Write a note.", parameters: Type.Object({ text: Type.String() }), execute: async () => ({ content: [{ type: "text" as const, text: "noted" }], details: undefined }) };
	const spec = { model: "faux/a", system: "Work.", output: Type.Object({ answer: Type.Integer() }), tools: [noop], checkpoint: "work/a.session.json", retries: [1, 1] };
	// Turn 1 completes; turn 2 dies with a non-transient error (a stand-in for a crash).
	let n = 0;
	const first = faux(() => (n++ === 0 ? call("note", { text: "step one" }) : error("401 invalid api key")));
	await assert.rejects(runAgent(first.models, spec, { q: 1 }), (e: unknown) => e instanceof AgentError && /401/.test(e.message));
	assert.equal(n, 2, "a non-transient error is not retried");
	// The re-run continues from turn 1: it is not requested again, and a 429 is retried with backoff.
	let m = 0;
	const lines: string[] = [];
	const second = faux((s) => (m++ === 0 ? error("429 Too Many Requests") : (assert.match(JSON.stringify(s.messages), /step one/), call("submit_result", { answer: 42 }))));
	const value = await runAgent(second.models, { ...spec, log: (l) => lines.push(l) }, { q: 1 });
	assert.deepEqual(value, { answer: 42 });
	assert.ok(lines.includes("resumed after turn 1"));
	assert.ok(lines.some((l) => l.startsWith("transient error (429")));
	assert.match(newest(second.seen.at(-1)!), /\[Turn 2 of 12\]/);
	assert.match(readFileSync("work/a.session.json", "utf8"), /"turns":2/);
});
