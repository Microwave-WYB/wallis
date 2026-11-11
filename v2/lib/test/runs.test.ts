// Run directories: ids, the project a workflow file belongs to, meta
// derived from the log (cached atomically, rebuilt when stale), and the
// lock that keeps two processes from writing one run.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SEMANTICS } from "../src/host/core.ts";
import { Journal } from "../src/host/journal.ts";
import { acquireLock, listRuns, lockHolder, newRunId, projectOf, readMeta, RunLocked, runPaths, runsDir } from "../src/host/runs.ts";
import { tmp } from "./util.ts";

test("a run id is <workflow>-<utc time>-<random>, sortable", () => {
	const id = newRunId("negatives", new Date(Date.UTC(2026, 10, 7, 9, 5, 3)));
	assert.match(id, /^negatives-20261107-090503-[0-9a-f]{4}$/);
	assert.match(newRunId("a b/c"), /^a-b-c-/);
});

test("a workflow file belongs to its nearest ancestor with .wallis or package.json, not the cwd", () => {
	const root = tmp();
	writeFileSync(join(root, "package.json"), "{}");
	mkdirSync(join(root, "negative", "deep"), { recursive: true });
	assert.equal(projectOf(join(root, "negative", "deep", "workflow.ts")), root);
	mkdirSync(join(root, "negative", ".wallis"));
	assert.equal(projectOf(join(root, "negative", "deep", "workflow.ts")), join(root, "negative"));
});

test("meta is the facts the log notes, cached with the log size and rebuilt when stale", () => {
	const paths = runPaths(join(runsDir(tmp()), "w-1"));
	mkdirSync(paths.dir, { recursive: true });
	assert.equal(readMeta(paths), null);
	const j = Journal.open(paths.log);
	j.step({ type: "started", workflow: { name: "w", digest: "d" }, input: null, semantics: SEMANTICS });
	j.step({ type: "noted", key: "workflow", value: "w" });
	assert.deepEqual(readMeta(paths), { workflow: "w", run_id: "w-1" });
	j.step({ type: "noted", key: "module", value: "/x/workflow.ts" });
	assert.deepEqual(readMeta(paths), { workflow: "w", module: "/x/workflow.ts", run_id: "w-1" });
	assert.equal(JSON.parse(readFileSync(paths.meta, "utf8")).meta.module, "/x/workflow.ts");
	assert.equal(listRuns(join(paths.dir, "..", "..", "..")).length, 1);
});

test("the lock admits one process; a dead holder's lock is taken over", async () => {
	const paths = runPaths(join(tmp(), "r"));
	const release = acquireLock(paths);
	assert.equal(lockHolder(paths), process.pid);
	release();
	assert.equal(lockHolder(paths), null);
	const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
	const pid = sleeper.pid!;
	// Another live process holds it: refused.
	try {
		acquireLock(paths, pid);
		assert.throws(() => acquireLock(paths), RunLocked);
	} finally {
		sleeper.kill("SIGKILL");
	}
	await new Promise((done) => sleeper.on("exit", done));
	// A dead holder: stale, taken over.
	const again = acquireLock(paths);
	assert.equal(lockHolder(paths), process.pid);
	again();
});
