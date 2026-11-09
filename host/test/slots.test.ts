// Machine-wide slots (flock): resource slots for scripts and per-provider
// concurrency for LLM calls.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeExecutor } from "../src/host/index.ts";
import type { NodeSpec } from "../src/host/executor.ts";
import { acquire, limitProviders, MachineSlots } from "../src/host/slots.ts";

const kind = () => `test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

test("slots are exclusive across holders and released after use", async () => {
	const k = kind();
	const first = await acquire(k, 1, 1);
	let second = false;
	const waiting = acquire(k, 1, 1, 50).then((release) => {
		second = true;
		return release;
	});
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(second, false, "the only slot is held");
	first();
	const release = await waiting;
	assert.equal(second, true);
	release();
	await assert.rejects(acquire(k, 2, 1), /needs 2/);
});

test("scripts declaring resources run one at a time on a one-GPU machine", async () => {
	const slots = new MachineSlots({ gpu: 1 });
	let running = 0;
	let peak = 0;
	const job = () =>
		slots.withSlot({ gpu: 1 }, async () => {
			peak = Math.max(peak, ++running);
			await new Promise((r) => setTimeout(r, 100));
			running--;
		});
	await Promise.all([job(), job(), job()]);
	assert.equal(peak, 1);
});

test("per-provider limits throttle LLM turns machine-wide", async () => {
	let running = 0;
	let peak = 0;
	const fake = new FakeExecutor({
		a: async () => {
			peak = Math.max(peak, ++running);
			await new Promise((r) => setTimeout(r, 100));
			running--;
			return { submit: null };
		},
	});
	const provider = kind();
	const limited = limitProviders(fake, { [provider]: 1 });
	const spec = { id: "#0", agent: "a", model: `${provider}/m`, transcript: [], maxTurns: 4, outputSchema: {} } as unknown as NodeSpec;
	const sessions = await Promise.all([limited.start(spec), limited.start({ ...spec, id: "#1" }), limited.start({ ...spec, id: "#2" })]);
	await Promise.all(sessions.map((s) => s.turn()));
	assert.equal(peak, 1);
});

import { spawnSync } from "node:child_process";
import { systemdAvailable } from "../src/host/slots.ts";
import { fakeExecutor, onlyRun, project, wallis } from "./util.ts";

const hasSystemd = systemdAvailable();
if (!hasSystemd) process.stderr.write("slots.test: systemd-run --user is unavailable; the systemd host test is skipped\n");

test("detached run hosts start as systemd user units and exit when the run is idle", { skip: !hasSystemd && "systemd-run --user unavailable" }, () => {
	const root = project();
	const env = { WALLIS_HOST: "systemd" };
	const started = wallis(root, ["run", "ask", "--input", '{"topic":"x"}', "--executor", fakeExecutor, "--detach"], env);
	assert.equal(started.status, 0, started.stderr);
	const id = onlyRun(root);
	const asked = wallis(root, ["wait", id, "--timeout", "30"], env);
	assert.match(asked.stdout, /ended its turn with a question/);
	// The unit ran and is gone (collected) once its host exited at the idle run.
	const unit = spawnSync("systemctl", ["--user", "is-active", `wallis-run-${id}`], { encoding: "utf8" });
	assert.notEqual(unit.stdout.trim(), "active");
	assert.equal(wallis(root, ["send", id, "#0:0", "newcomers"], env).status, 0);
	assert.match(wallis(root, ["wait", id, "--timeout", "30"], env).stdout, /finished, done/);
});
