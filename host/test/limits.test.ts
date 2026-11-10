// Per-sandbox memory and process limits: every sandboxed process runs in a
// systemd user scope (MemoryMax, MemorySwapMax=0, TasksMax). A limit hit
// stops the scope and the command fails with `resource_limit`, naming the
// limit. Real bwrap and a systemd user manager; skipped without them.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { bwrapAvailable, FakeExecutor, ProcessCommands, RunRefused, runWorkflow } from "../src/host/index.ts";
import { hostProgram } from "../src/host/hostbin.ts";
import { DEFAULT_MEMORY_MAX, DEFAULT_TASKS_MAX, parseMemLimit, scopeFor, scopePrefix } from "../src/host/limits.ts";
import { systemdAvailable } from "../src/host/slots.ts";
import { tmp } from "./util.ts";

const hasBwrap = bwrapAvailable();
const hasSystemd = systemdAvailable();
const skip = !hasBwrap ? "bubblewrap cannot create a sandbox here" : !hasSystemd ? "no systemd user manager (systemd-run --user --scope fails)" : false;
const noPython = skip || (!existsSync("/usr/bin/python3") && "no /usr/bin/python3");
if (skip) process.stderr.write(`limits.test: ${skip}; the limit tests under real bwrap are skipped\n`);

const systemctl = (...args: string[]) => spawnSync(hostProgram("systemctl"), ["--user", ...args], { encoding: "utf8" });
/** This process's sandbox scopes that are still loaded. */
const liveScopes = () =>
	systemctl("list-units", "--type=scope", "--all", "--plain", "--no-legend", `${scopePrefix()}-*`)
		.stdout.split("\n")
		.map((l) => l.trim().split(/\s+/)[0] ?? "")
		.filter((u) => u.startsWith(scopePrefix()));

// Stop every scope these tests started, so no `sleep` (or anything) remains.
after(() => {
	if (skip) return;
	systemctl("stop", `${scopePrefix()}-*`);
	systemctl("reset-failed", `${scopePrefix()}-*`);
	assert.deepEqual(liveScopes(), [], "no sandbox scope remains");
});

function workflowText(sandbox: string, argv: string[], requires: string) {
	return `import { command, defineModels, defineSandbox, Type, workflow } from "wallis";
const box = defineSandbox({}, { name: "box", requires: [${requires}], ${sandbox} });
const go = command({ name: "go", sandbox: box, input: Type.Null(), output: Type.String(), run: () => ${JSON.stringify(argv)}, parse: (r) => r.stdout });
export default workflow({ name: "limits", models: defineModels({ default: "fake/default" }), agents: [], commands: [go], input: Type.Null(), output: Type.String(),
	run: async (ctx) => ctx.call(go, null) });
`;
}

async function runCommand(sandbox: string, argv: string[], requires = `{ name: "sh", check: ["sh", "-c", "true"] }`) {
	const root = tmp("wallis-limits-");
	const wf = join(root, "wf");
	mkdirSync(wf);
	const workflow = join(wf, "workflow.ts");
	writeFileSync(workflow, workflowText(sandbox, argv, requires));
	// Only the programs the sandbox requires.
	const bins: Record<string, string> = requires.includes("python3") ? { python3: realpathSync("/usr/bin/python3") } : { sh: "/bin/sh" };
	return runWorkflow({ workflow, dir: join(root, "r1"), root, executor: new FakeExecutor({}), commands: new ProcessCommands(), confine: "require", bins, input: null, local: {}, inboxPollMs: null });
}

/** The command's held failure, from the idle run. */
function heldFailure(r: Awaited<ReturnType<typeof runCommand>>): unknown {
	assert.equal(r.status.type, "idle", JSON.stringify(r.status));
	const reason = r.status.type === "idle" ? r.status.reason : null;
	assert.equal(reason?.type, "node_failure", JSON.stringify(reason));
	if (reason?.type !== "node_failure") return null;
	assert.equal(reason.reason.type, "command_crashed");
	return reason.reason.type === "command_crashed" ? reason.reason.failure : null;
}

test("mem_limit parses compose sizes; anything else is refused", () => {
	assert.deepEqual(parseMemLimit("64m"), { ok: true, bytes: 64 * 1024 ** 2 });
	assert.deepEqual(parseMemLimit("2g"), { ok: true, bytes: 2 * 1024 ** 3 });
	assert.deepEqual(parseMemLimit("4096k"), { ok: true, bytes: 4 * 1024 ** 2 });
	for (const bad of ["2", "2x", "1.5g", "-1g", "0m", "2G ", "512"]) assert.equal(parseMemLimit(bad).ok, false, bad);
	// Defaults, a command's memoryGb in place of the default memory, capped by mem_limit.
	const none = { mem_limit: null, pids_limit: null };
	assert.equal(scopeFor(none).memoryMax, DEFAULT_MEMORY_MAX);
	assert.equal(scopeFor(none).tasksMax, DEFAULT_TASKS_MAX);
	assert.equal(scopeFor(none, { memoryGb: 16 }).memoryMax, 16 * 1024 ** 3);
	assert.equal(scopeFor({ mem_limit: "2g", pids_limit: 7 }, { memoryGb: 16 }).memoryMax, 2 * 1024 ** 3);
	assert.equal(scopeFor({ mem_limit: "2g", pids_limit: 7 }).tasksMax, 7);
	assert.notEqual(scopeFor(none).unit, scopeFor(none).unit, "one scope per process");
});

test("a bad mem_limit or pids_limit is an invalid declaration, refused before anything runs", async () => {
	for (const sandbox of [`mem_limit: "2x" as "2g"`, "pids_limit: 0"]) {
		const root = tmp("wallis-limits-decl-");
		mkdirSync(join(root, "wf"));
		const workflow = join(root, "wf", "workflow.ts");
		writeFileSync(workflow, workflowText(sandbox, ["true"], `"sh"`));
		await assert.rejects(
			runWorkflow({ workflow, dir: join(root, "r1"), root, executor: new FakeExecutor({}), confine: "off", input: null, local: {}, inboxPollMs: null }),
			(e: unknown) => e instanceof RunRefused && e.refusal.type === "invalid_declaration" && /mem_limit|pids_limit/.test(e.refusal.message),
		);
	}
});

test("process limit: pids_limit 16 and 32 background sleeps: resource_limit pids_limit, the scope is stopped", { skip, timeout: 60_000 }, async () => {
	const started = Date.now();
	const r = await runCommand("pids_limit: 16", ["sh", "-c", "for i in $(seq 1 32); do sleep 30 & done; wait"]);
	assert.deepEqual(heldFailure(r), { type: "resource_limit", limit: "pids_limit", max: 16 });
	assert.ok(Date.now() - started < 25_000, "stopped at the limit, not after the sleeps");
	assert.deepEqual(liveScopes(), [], "the whole scope was stopped: no sleep remains");
});

test("memory limit: mem_limit 64m and a 256 MiB allocation: resource_limit mem_limit", { skip: noPython, timeout: 60_000 }, async () => {
	const r = await runCommand(`mem_limit: "64m"`, ["python3", "-c", "b = bytearray(256*1024*1024)"], `"python3"`);
	assert.deepEqual(heldFailure(r), { type: "resource_limit", limit: "mem_limit", max: 64 * 1024 ** 2 });
	assert.deepEqual(liveScopes(), [], "the failed scope was read and cleared");
});

test("default limits: a sandbox with no overrides runs in a scope with MemoryMax 8G, no swap and TasksMax 512", { skip, timeout: 60_000 }, async () => {
	const running = runCommand("", ["sh", "-c", "sleep 3; echo ok"]);
	let props = "";
	for (let i = 0; i < 100 && props === ""; i++) {
		await new Promise((r) => setTimeout(r, 50));
		const [unit] = liveScopes().filter((u) => systemctl("show", "-p", "ActiveState", "--value", u).stdout.trim() === "active");
		if (unit) props = systemctl("show", "-p", "MemoryMax", "-p", "MemorySwapMax", "-p", "TasksMax", unit).stdout;
	}
	const r = await running;
	assert.equal(r.outcome?.type, "done", JSON.stringify(r.status));
	assert.match(props, new RegExp(`^MemoryMax=${DEFAULT_MEMORY_MAX}$`, "m"));
	assert.match(props, /^MemorySwapMax=0$/m);
	assert.match(props, new RegExp(`^TasksMax=${DEFAULT_TASKS_MAX}$`, "m"));
});
