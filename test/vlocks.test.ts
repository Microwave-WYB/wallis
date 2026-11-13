// Named volumes, Docker-style: "name:/t:ro" is read-only and shared; "name:/t" is writable and
// exclusive (no reader meanwhile). The locks are flock(2): a dead holder never keeps one. A stop
// ends a wait, and status shows it. One volume at two targets is an error.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { lockVolumes, namedVolumesDir, parseVolume, resolveVolumes } from "../src/host/volumes.ts";
import { NodeFailed, run } from "../src/index.ts";
import { here, project, tmp } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };

async function fixture() {
	const root = project({ "wf.ts": readFileSync(join(here, "fixtures/vlocks.ts"), "utf8") }, { models: { default: "faux/m" }, executor: join(here, "fixtures/faux.ts") });
	return { root, wf: (await import(pathToFileURL(join(root, "wf.ts")).href)) as typeof import("./fixtures/vlocks.ts") };
}

test("a named volume with :ro parses as a read-only named volume", () => {
	assert.deepEqual(parseVolume("venv:/opt/venv:ro"), { kind: "named", name: "venv", target: "/opt/venv", readOnly: true });
	assert.deepEqual(parseVolume("venv:/opt/venv"), { kind: "named", name: "venv", target: "/opt/venv", readOnly: false });
	assert.equal(parseVolume("/abs:/x:ro").kind, "invalid");
});

test("one volume at two targets in one sandbox is an error", () => {
	const dir = tmp();
	assert.throws(() => resolveVolumes(["env:/a", "env:/b:ro"], dir), /the volume env is already mounted at \/a/);
});

test("readers of a :ro volume run at the same time", opts, async () => {
	const { wf } = await fixture();
	const r = await run(wf.readers, {});
	assert.ok(r.output.ms < 1500, `three 0.6 s readers took ${r.output.ms} ms`);
});

test("a writer has its volume alone: a reader waits for it", opts, async () => {
	const { wf } = await fixture();
	const r = await run(wf.mixed, {});
	assert.ok(r.output.ms >= 1150, `a 0.6 s writer and a 0.6 s reader overlapped: ${r.output.ms} ms`);
});

test("a :ro mount is read-only", opts, async () => {
	const { wf } = await fixture();
	await assert.rejects(run(wf.readOnly, {}), (e: unknown) => e instanceof NodeFailed && /Read-only file system/.test(e.message));
});

test("a waiting call shows in status, and a stop ends the wait", opts, async () => {
	const { wf } = await fixture();
	const r = await run(wf.contended, {}, { detach: true });
	let waiting: readonly { volume: string }[] = [];
	for (let i = 0; i < 200 && waiting.length === 0; i++) {
		await new Promise((d) => setTimeout(d, 50));
		waiting = (await r.status()).waiting;
	}
	assert.deepEqual(waiting.map((w) => w.volume), ["env"]);
	const t = Date.now();
	await r.stop();
	assert.equal((await r.next({ timeout: "10s" })).type, "stopped");
	assert.ok(Date.now() - t < 8000, "the stop did not wait for the 30 s writer");
});

test("a lock whose holder died is free (flock: the kernel releases it), and an empty lock file holds nothing", async () => {
	const root = tmp();
	const [v] = resolveVolumes(["env:/opt/env"], root);
	// A holder process that dies at once, holding the lock.
	const holder = spawn("flock", ["-x", `${v!.dir}.lock`, "-c", "kill -9 $PPID"], { stdio: "ignore" });
	await new Promise((d) => holder.once("close", d));
	writeFileSync(`${v!.dir}.lock`, "");
	const t = Date.now();
	const locks = await lockVolumes([v!]);
	await locks.release();
	assert.ok(Date.now() - t < 2000);
});
