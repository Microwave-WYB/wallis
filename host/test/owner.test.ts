// Ownership: a run belongs to the harness that started it (or the human);
// only the owner waits on, answers and steers it; anyone may read it;
// `claim` reassigns it, as a logged event.

import assert from "node:assert/strict";
import { test } from "node:test";
import { logOf, onlyRun, project, fakeExecutor, wallis } from "./util.ts";

const ask = ["run", "ask", "--input", '{"topic":"folds"}', "--executor", fakeExecutor];
const as = (owner: string) => ({ WALLIS_OWNER: owner });

test("only the owner answers; reads work for anyone; claim hands a run over", () => {
	const root = project();
	assert.equal(wallis(root, ask, as("harness:alpha")).status, 0);
	const id = onlyRun(root);
	assert.deepEqual(logOf(root, id).filter((e) => e.type === "claimed"), [{ type: "claimed", owner: "harness:alpha" }]);

	// beta may read, not answer or wait.
	assert.equal(wallis(root, ["status", id, "--json"], as("harness:beta")).status, 0);
	const send = wallis(root, ["send", id, "#0", "hi"], as("harness:beta"));
	assert.equal(send.status, 1);
	assert.match(send.stderr, /is owned by harness:alpha, not by harness:beta.*npx wallis claim/);
	assert.match(wallis(root, ["wait", id], as("harness:beta")).stderr, /is owned by harness:alpha/);
	// pending shows only own runs.
	assert.match(wallis(root, ["pending"], as("harness:alpha")).stdout, /Who is the audience/);
	assert.equal(wallis(root, ["pending"], as("harness:beta")).stdout, "");

	// beta claims it (a logged event) and can answer.
	assert.equal(wallis(root, ["claim", id], as("harness:beta")).status, 0);
	assert.deepEqual(logOf(root, id).filter((e) => e.type === "claimed").at(-1), { type: "claimed", owner: "harness:beta" });
	assert.match(wallis(root, ["send", id, "#0", "alpha"], as("harness:alpha")).stderr, /owned by harness:beta/);
	assert.equal(wallis(root, ["send", id, "#0", "newcomers"], as("harness:beta")).status, 0);
	assert.match(wallis(root, ["wait", id, "--timeout", "30"], as("harness:beta")).stdout, /finished, done/);
});

test("the human owns everything; wait with no run waits on the caller's own runs", () => {
	const root = project();
	assert.equal(wallis(root, ask, as("harness:alpha")).status, 0);
	const id = onlyRun(root);
	// The caller's own runs: alpha's question is reported by a bare wait.
	const own = wallis(root, ["wait", "--timeout", "10"], as("harness:alpha"));
	assert.equal(own.status, 0);
	assert.match(own.stdout, /Who is the audience/);
	// beta has no runs: a bare wait times out.
	assert.equal(wallis(root, ["wait", "--timeout", "1"], as("harness:beta")).status, 2);
	// The human may answer any run.
	assert.equal(wallis(root, ["send", id, "#0", "newcomers"], as("human")).status, 0);
	assert.match(wallis(root, ["wait", id, "--timeout", "30"], as("human")).stdout, /finished, done/);
});

test("pending mentions runs whose owner is gone, and they can be claimed", () => {
	const root = project();
	// An owner whose process no longer exists.
	assert.equal(wallis(root, ask, as("harness:ghost:999999:1")).status, 0);
	const id = onlyRun(root);
	const pending = wallis(root, ["pending"], as("harness:beta"));
	assert.match(pending.stdout, new RegExp(`1 run\\(s\\) have no live owner and can be claimed: npx wallis claim ${id}`));
	assert.equal(wallis(root, ["claim", id], as("harness:beta")).status, 0);
	assert.match(wallis(root, ["pending"], as("harness:beta")).stdout, /Who is the audience/);
});

test("under a harness, wallis serve behind a wrapper and the harness's own CLI calls resolve to the same owner", async () => {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const { spawnSync } = await import("node:child_process");
	const { join, resolve } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const { cliEnv, tmp } = await import("./util.ts");
	const dir = tmp();
	const owner = resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/host/owner.ts");
	// What `wallis serve` and a CLI call compute, each started through `sh -c` (as `npx` or `mise exec` would).
	writeFileSync(join(dir, "probe.ts"), `import { callerIdentity, serverOwner } from ${JSON.stringify(owner)};\nconsole.log(process.argv[2] === "server" ? serverOwner() : callerIdentity());\n`);
	mkdirSync(join(dir, "bin"));
	const harness = join(dir, "bin", "fakeharness.mjs");
	writeFileSync(
		harness,
		`import { execFileSync } from "node:child_process";
const run = (kind) => execFileSync("sh", ["-c", \`"\${process.execPath}" ${join(dir, "probe.ts")} \${kind}; true\`], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ server: run("server"), caller: run("caller") }));\n`,
	);
	const r = spawnSync(process.execPath, [harness], { encoding: "utf8", env: cliEnv({ WALLIS_HARNESSES: "fakeharness" }) });
	assert.equal(r.status, 0, r.stderr);
	const ids = JSON.parse(r.stdout) as { server: string; caller: string };
	assert.match(ids.server, /^harness:fakeharness:\d+:\d+$/);
	assert.equal(ids.caller, ids.server, "the orchestrator's MCP runs are its own for its CLI");
});
