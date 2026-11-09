// Run metadata is a cache: the host facts the log notes (`noted` events),
// derived when read and kept in meta.json with the log size it was derived
// at. A missing or stale cache is rebuilt from the log; the cache is written
// atomically (temp file, then rename), so a reader in another process never
// parses half a file.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeExecutor, runWorkflow } from "../src/host/index.ts";
import { EventLog } from "../src/host/log.ts";
import { readMeta, runPaths } from "../src/host/store.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const store = resolve(here, "../src/host/store.ts");
const twoNode = resolve(here, "../examples/two-node/workflow.ts");
const responses = { planner: { output: { outline: ["a"], note: "n" } }, writer: { output: { text: "t", words: 1 } } };

async function aRun(): Promise<string> {
	const dir = join(tmp(), "run");
	await runWorkflow({ workflow: twoNode, dir, executor: new FakeExecutor(responses), input: { topic: "x" }, inboxPollMs: null, confine: "off", executorModule: "/kit.ts" });
	return dir;
}

test("meta.json is derived from the facts the log notes; a missing or stale cache is rebuilt", async () => {
	const dir = await aRun();
	const paths = runPaths(dir);
	const noted = new EventLog(paths.log).read().flatMap((e) => (e.type === "noted" ? [e.key] : []));
	assert.deepEqual(noted.slice(0, 4), ["workflow", "root", "executor", "created"]);
	const meta = readMeta(paths)!;
	assert.equal(meta.workflow, twoNode);
	assert.equal(meta.executor, "/kit.ts");
	assert.equal(meta.confined, false);
	rmSync(paths.meta);
	assert.deepEqual(readMeta(paths), meta);
	// A cache from another log size is not trusted.
	writeFileSync(paths.meta, JSON.stringify({ log_bytes: 1, meta: { ...meta, executor: "/stale.ts" } }));
	assert.equal(readMeta(paths)!.executor, "/kit.ts");
});

/** A node process running `body` with `store.ts` imported as `s` and the run's paths as `paths`. */
function child(dir: string, body: string): Promise<number | null> {
	const code = `import * as s from ${JSON.stringify(store)}; const paths = s.runPaths(${JSON.stringify(dir)}); ${body}`;
	const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit"] });
	return new Promise((done) => p.on("exit", (status) => done(status)));
}

test("a reader never sees a half-written meta.json while another process rebuilds it", async () => {
	const dir = await aRun();
	const paths = runPaths(dir);
	let done = false;
	const writer = child(dir, 'import { rmSync } from "node:fs"; for (let i = 0; i < 200; i++) { rmSync(paths.meta, { force: true }); s.readMeta(paths); }').then((status) => {
		done = true;
		return status;
	});
	let reads = 0;
	while (!done) {
		assert.equal(readMeta(paths)!.run_id, paths.id);
		reads++;
		await new Promise((r) => setImmediate(r));
	}
	assert.equal(await writer, 0);
	assert.ok(reads > 0);
});
