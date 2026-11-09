// Workspaces as layers: a session value's /w is an overlay of immutable,
// content-addressed layers. After each call its upper dir (only the
// changes) becomes a new layer; the session after it is the parent's
// layers plus that one, squashed beyond 16. The fake worker writes into its
// upper dir and lists /w through the layers, as the host's file tools do.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSpawn } from "../src/host/confine.ts";
import { appendInbox, bwrapAvailable, FakeExecutor, ProcessCommands, runPaths, runWorkflow } from "../src/host/index.ts";
import { commitLayer, layerDir, listIn, prepareWork, readManifest, resolveIn, squash } from "../src/host/layers.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const workflow = resolve(here, "fixtures/workspace/workflow.ts");

/** Writes its file into the call's upper dir, then reports /w as the overlay shows it. */
function worker(spoil?: { file: string }) {
	return new FakeExecutor({
		worker: (call) => {
			const step = call.input as { write: string | null; size?: number };
			if (spoil && step.write === spoil.file && !existsSync(join(call.workspace.scratch, "spoiled"))) {
				writeFileSync(join(call.workspace.scratch, "spoiled"), "the first attempt's file");
				return { giveUp: "spoiled" };
			}
			if (step.write !== null) writeFileSync(join(call.workspace.scratch, step.write), step.size ? Buffer.alloc(step.size, 1) : step.write);
			return { submit: { saw: listIn(call.workspace.work!, "") ?? [] } };
		},
	});
}

const opts = (dir: string, mode: string) => ({ workflow, dir, input: { mode }, confine: "off" as const, inboxPollMs: null });

test("two concurrent branches from one session value each see the parent's files and only their own", async () => {
	const dir = join(tmp(), "run");
	const done = await runWorkflow({ ...opts(dir, "branches"), executor: worker() });
	assert.deepEqual(done.outcome, {
		type: "done",
		value: { x: ["a.txt", "x.txt"], y: ["a.txt", "y.txt"], afterX: ["a.txt", "x.txt"], afterY: ["a.txt", "y.txt"] },
	});
	// Each call's changes are one layer: a.txt, x.txt and y.txt each once; the calls that wrote nothing added none.
	const layers = readdirSync(join(dir, "layers")).filter((f) => !f.endsWith(".json"));
	assert.equal(layers.length, 3);
	for (const l of layers) assert.equal(Object.keys(readManifest(dir, `sha256:${l}`)).length, 1);
});

test("a session seeded from ctx.files(s) gets its files copy-on-write; s never sees the seeded session's writes", async () => {
	const dir = join(tmp(), "run");
	const done = await runWorkflow({ ...opts(dir, "from"), executor: worker() });
	const value = (done.outcome as unknown as { value: { seeded: string[]; original: string[]; tree: { kind: string; layers: string[] } } }).value;
	assert.deepEqual(value.seeded, ["a.txt", "c.txt"]);
	assert.deepEqual(value.original, ["a.txt"]);
	// The Tree names layers in the store: nothing was copied for it.
	assert.equal(value.tree.kind, "tree");
	assert.equal(value.tree.layers.length, 1);
	assert.ok(existsSync(layerDir(dir, value.tree.layers[0]!)));
});

test("past 16 layers the stack is squashed into one; every file is still there", async () => {
	const dir = join(tmp(), "run");
	const done = await runWorkflow({ ...opts(dir, "deep"), executor: worker() });
	const value = (done.outcome as unknown as { value: { saw: string[]; layers: number } }).value;
	assert.deepEqual(value.saw, ["a.txt", ...Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`)]);
	assert.ok(value.layers <= 16, `${value.layers} layers`);
});

test("an unchanged 50 MB file in a lower layer is never copied or hashed again, also when the stack is squashed", async () => {
	const dir = join(tmp(), "run");
	const done = await runWorkflow({ ...opts(dir, "big"), executor: worker() });
	const layers = (done.outcome as unknown as { value: { layers: string[] } }).value.layers;
	// The layer that holds it: written once, by the call that wrote it.
	const holders = readdirSync(join(dir, "layers"))
		.filter((f) => f.endsWith(".json"))
		.filter((f) => "big.bin" in (JSON.parse(readFileSync(join(dir, "layers", f), "utf8")) as object));
	// Its own layer and the squashed one: one inode, so one copy on disk; the squash merged manifests, never read it.
	assert.equal(holders.length, 2);
	const inodes = new Set(holders.map((f) => statSync(join(dir, "layers", f.replace(/\.json$/, ""), "big.bin")).ino));
	assert.equal(inodes.size, 1);
	const shas = new Set(holders.map((f) => (JSON.parse(readFileSync(join(dir, "layers", f), "utf8")) as Record<string, { sha256: string }>)["big.bin"]!.sha256));
	assert.equal(shas.size, 1);
	// No later layer has it: the calls that did not touch it hashed only what they wrote.
	for (const l of layers.slice(1)) assert.ok(!("big.bin" in readManifest(dir, l)));
	assert.ok("big.bin" in readManifest(dir, layers[0]!));
});

test("a restarted call starts from its session's workspace again: the discarded attempt's files are gone", async () => {
	const dir = join(tmp(), "run");
	const failed = await runWorkflow({ ...opts(dir, "restart"), executor: worker({ file: "two.txt" }) });
	assert.equal(failed.status.type, "idle");
	appendInbox(runPaths(dir), { id: "r1", type: "restart", node: "#1", by: "human" });
	const done = await runWorkflow({ workflow, dir, confine: "off", inboxPollMs: null, executor: worker() });
	// The workspace matches the dialogue: the first attempt's file is not in the second's /w.
	assert.deepEqual(done.outcome, { type: "done", value: { two: ["a.txt", "two.txt"] } });
});

test("under bwrap an agent's /w is the kernel's overlay: its bash sees the layers below, and a deletion holds in the next call", { skip: !bwrapAvailable() && "bwrap cannot create a sandbox here" }, async () => {
	const dir = join(tmp(), "run");
	const executor = new FakeExecutor({
		shell: async (call) => {
			if (call.sandbox.type !== "bwrap") return { giveUp: `no sandbox: ${call.sandbox.type}` };
			const r = await runSpawn(call.sandbox.spawn(["bash", "-c", (call.input as { script: string }).script]), "", { timeoutMs: 20_000 });
			return { submit: { out: `${r.stdout}${r.stderr}` } };
		},
	});
	const done = await runWorkflow({ workflow, dir, input: { mode: "shell" }, inboxPollMs: null, confine: "require", bins: { bash: "/usr/bin/bash" }, executor });
	assert.deepEqual(done.outcome, { type: "done", value: { listed: ".:\na.txt\nd\n\n./d:\ne\n" } });
	// The second call's layer records the deletion as a whiteout.
	const whiteouts = readdirSync(join(dir, "layers")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, "layers", f), "utf8")) as Record<string, { type: string }>);
	assert.ok(whiteouts.some((m) => m["b.txt"]?.type === "whiteout"));
});

test("a host killed between a layer's commit and the event that names it resumes with the call's changes; the layer store is not corrupted", async () => {
	const dir = join(tmp(), "run");
	const { spawnSync } = await import("node:child_process");
	// The third commit (the second deep call's) lands in the store; the host dies before logging it.
	const code = `
		import { writeFileSync } from "node:fs";
		import { join } from "node:path";
		import { FakeExecutor, runWorkflow } from ${JSON.stringify(resolve(here, "../src/host/index.ts"))};
		import { listIn } from ${JSON.stringify(resolve(here, "../src/host/layers.ts"))};
		const executor = new FakeExecutor({ worker: (call) => {
			if (call.input.write !== null) writeFileSync(join(call.workspace.scratch, call.input.write), call.input.write);
			return { submit: { saw: listIn(call.workspace.work, "") ?? [] } };
		} });
		await runWorkflow({ workflow: ${JSON.stringify(workflow)}, dir: ${JSON.stringify(dir)}, input: { mode: "deep" }, confine: "off", inboxPollMs: null, executor });`;
	const killed = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, WALLIS_CRASH_AT: "layer:3" }, timeout: 60_000 });
	assert.equal(killed.signal, "SIGKILL", killed.stderr);
	const done = await runWorkflow({ workflow, dir, confine: "off", inboxPollMs: null, executor: worker() });
	const value = (done.outcome as unknown as { value: { saw: string[] } }).value;
	assert.deepEqual(value.saw, ["a.txt", ...Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`)]);
	// Every layer the log names is in the store, with its manifest.
	const { EventLog } = await import("../src/host/log.ts");
	for (const e of new EventLog(join(dir, "log.jsonl")).read()) {
		if (e.type !== "agent_returned" || e.layers === null) continue;
		for (const l of e.layers) assert.ok(existsSync(layerDir(dir, l)) && existsSync(`${layerDir(dir, l)}.json`), l);
	}
});

/** The shell agent, run for real in its bwrap sandbox. */
function shell() {
	return new FakeExecutor({
		shell: async (call) => {
			if (call.sandbox.type !== "bwrap") return { giveUp: `no sandbox: ${call.sandbox.type}` };
			const r = await runSpawn(call.sandbox.spawn(["bash", "-c", (call.input as { script: string }).script]), "", { timeoutMs: 20_000 });
			return { submit: { out: `${r.stdout}${r.stderr}` } };
		},
	});
}

const bwrap = { skip: !bwrapAvailable() && "bwrap cannot create a sandbox here" };
const real = (dir: string, mode: string) => ({ workflow, dir, input: { mode }, inboxPollMs: null, confine: "require" as const, bins: { bash: "/usr/bin/bash" }, commands: new ProcessCommands() });

test("a one-layer Tree is mounted read-only for a command and for an exec agent", bwrap, async () => {
	const done = await runWorkflow({ ...real(join(tmp(), "run"), "tree"), executor: shell() });
	assert.deepEqual(done.outcome, { type: "done", value: { layers: 1, command: "from-tree", agent: "from-tree" } });
});

test("a layer written back to an earlier state is not named twice in one overlay: the stack is squashed", bwrap, async () => {
	const done = await runWorkflow({ ...real(join(tmp(), "run"), "rewrite"), executor: shell() });
	assert.deepEqual(done.outcome, { type: "done", value: { read: "x", layers: 1 } });
});

/** A layer committed from an upper dir built by hand (as the kernel leaves it). */
function layerOf(runDir: string, build: (upper: string) => void): string {
	const root = join(runDir, "work", `hand-${Math.random().toString(16).slice(2)}`);
	const work = prepareWork(runDir, root, []);
	if ("missing" in work) throw new Error("no work");
	build(work.upper);
	return commitLayer(runDir, work, root)!;
}

test("a file or symlink over a lower layer's directory replaces it: squash and lookups drop what was under it", () => {
	const dir = tmp();
	const lower = layerOf(dir, (u) => {
		mkdirSync(join(u, "a"));
		writeFileSync(join(u, "a", "x"), "x");
		mkdirSync(join(u, "b"));
		writeFileSync(join(u, "b", "y"), "y");
	});
	// rm -rf a; echo f > a (and the same with a symlink): no whiteout, just the new entry.
	const upper = layerOf(dir, (u) => {
		writeFileSync(join(u, "a"), "f");
		symlinkSync("a", join(u, "b"));
	});
	const stack = [lower, upper];
	const work = { lowers: stack.map((l) => layerDir(dir, l)), upper: join(dir, "nothing"), ovl: "" };
	assert.equal(resolveIn(work, "a/x"), null);
	assert.equal(resolveIn(work, "b/y"), null);
	assert.deepEqual(listIn(work, ""), ["a", "b"]);
	const squashed = readManifest(dir, squash(dir, stack));
	assert.deepEqual(Object.keys(squashed).sort(), ["a", "b"]);
	assert.equal(squashed.a!.type, "file");
	assert.equal(squashed.b!.type, "symlink");
});
