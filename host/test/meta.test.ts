// Run metadata is written atomically (temp file, then rename), so a reader
// in another process (`wallis wait`, `inspectRun`) never parses half a file;
// read-modify-write goes through `updateMeta` under a lock, so concurrent
// writers in different processes never lose each other's changes.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readMeta, runPaths, writeMeta } from "../src/host/store.ts";
import { tmp } from "./util.ts";

const store = resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/host/store.ts");

/** A node process running `body` with `store.ts` imported as `s` and the run's paths as `paths`. */
function child(dir: string, body: string): Promise<number | null> {
	const code = `import * as s from ${JSON.stringify(store)}; const paths = s.runPaths(${JSON.stringify(dir)}); ${body}`;
	const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit"] });
	return new Promise((done) => p.on("exit", (status) => done(status)));
}

const base = (dir: string) => ({ run_id: runPaths(dir).id, workflow: "w.ts", root: "/", executor: null, created: "now" });

test("a reader never sees a half-written meta.json while another process rewrites it", async () => {
	const dir = join(tmp(), "run");
	const paths = runPaths(dir);
	writeMeta(paths, base(dir));
	// Large enough that a truncate-then-write is caught midway.
	let done = false;
	const writer = child(
		dir,
		'const m = s.readMeta(paths); const w = Array.from({ length: 4000 }, (_, i) => `warning ${i} ${"x".repeat(40)}`); for (let i = 0; i < 300; i++) s.writeMeta(paths, { ...m, warnings: w.slice(0, 3000 + i) });',
	).then((status) => {
		done = true;
		return status;
	});
	let reads = 0;
	while (!done) {
		const meta = readMeta(paths);
		assert.ok(meta === null || meta.run_id === paths.id);
		reads++;
		await new Promise((r) => setImmediate(r));
	}
	assert.equal(await writer, 0);
	assert.ok(reads > 0);
	assert.equal(readMeta(paths)!.warnings!.length, 3299);
});

test("concurrent updateMeta from two processes keeps every change", async () => {
	const dir = join(tmp(), "run");
	const paths = runPaths(dir);
	writeMeta(paths, base(dir));
	const adds = (who: string) => child(dir, `for (let i = 0; i < 150; i++) s.updateMeta(paths, (m) => ({ ...m, warnings: [...(m.warnings ?? []), "${who}" + i] }));`);
	assert.deepEqual(await Promise.all([adds("a"), adds("b")]), [0, 0]);
	const warnings = readMeta(paths)!.warnings!;
	assert.equal(warnings.length, 300);
	assert.equal(new Set(warnings).size, 300);
});
