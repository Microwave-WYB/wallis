// Workspaces as layers: a session value's /w is an overlay of immutable,
// content-addressed layers. After each call its upper dir (only the
// changes) becomes a new layer; the session after it is the parent's
// layers plus that one, squashed beyond 16. The fake worker writes into its
// upper dir and lists /w through the layers, as the host's file tools do.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSpawn } from "../src/host/confine.ts";
import { appendInbox, bwrapAvailable, FakeExecutor, ProcessCommands, runPaths, runWorkflow } from "../src/host/index.ts";
import { commitLayer, layerDir, listIn, locate, prepareWork, readManifest, resolveIn, squash, workRoot, writeViewFile } from "../src/host/layers.ts";
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

/** Every layer in the store still matches its manifest: each file re-hashed. */
function verifyLayers(dir: string): void {
	for (const f of readdirSync(join(dir, "layers")).filter((n) => n.endsWith(".json"))) {
		const manifest = JSON.parse(readFileSync(join(dir, "layers", f), "utf8")) as Record<string, { type: string; sha256?: string }>;
		for (const [path, entry] of Object.entries(manifest)) {
			if (entry.type !== "file") continue;
			const sha = createHash("sha256").update(readFileSync(join(dir, "layers", f.replace(/\.json$/, ""), path))).digest("hex");
			assert.equal(sha, entry.sha256, `${f} ${path}`);
		}
	}
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
	// The reissued call writes nothing: f01.txt can only come from the layer it committed.
	const resumed = new FakeExecutor({
		worker: (call) => {
			const step = call.input as { write: string | null };
			if (step.write !== null && step.write !== "f01.txt") writeFileSync(join(call.workspace.scratch, step.write), step.write);
			return { submit: { saw: listIn(call.workspace.work!, "") ?? [] } };
		},
	});
	const done = await runWorkflow({ workflow, dir, confine: "off", inboxPollMs: null, executor: resumed });
	const value = (done.outcome as unknown as { value: { saw: string[] } }).value;
	assert.deepEqual(value.saw, ["a.txt", ...Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`)]);
	verifyLayers(dir);
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

test("a commit marker restores only its own attempt, from the layer, replacing any upper dir left beside it", () => {
	const dir = tmp();
	const committed = layerOf(dir, (u) => writeFileSync(join(u, "done.txt"), "done"));
	const root = join(dir, "work", "_7");
	mkdirSync(join(root, "upper"), { recursive: true });
	writeFileSync(join(root, "upper", "stray.txt"), "half a copy");
	writeFileSync(join(root, "committed"), `${committed} 1`);
	// A restart (attempt 2) starts fresh: the marker is not its own.
	const other = prepareWork(dir, root, [], 2);
	if ("missing" in other) throw new Error("no work");
	assert.ok(!existsSync(join(root, "committed")));
	writeFileSync(join(root, "committed"), `${committed} 2`);
	const mine = prepareWork(dir, root, [], 2);
	if ("missing" in mine) throw new Error("no work");
	assert.deepEqual(readdirSync(mine.upper), ["done.txt"]);
});

test("overlay emulation: opaque marks on odd names, writes over a deletion, dir modes and special files through a squash", () => {
	const dir = tmp();
	// A dir name getfattr -R would escape: its opaque mark is still read.
	const odd = "we\\ird\nname";
	const marked = layerOf(dir, (u) => {
		mkdirSync(join(u, odd));
		assert.equal(spawnSync("setfattr", ["-n", "user.overlay.opaque", "-v", "y", "--", join(u, odd)]).status, 0);
	});
	assert.deepEqual(readManifest(dir, marked)[odd], { type: "dir", opaque: true, mode: statSync(join(layerDir(dir, marked), odd)).mode & 0o7777 });
	// A lower layer with a file and a dir; the call deleted both (bash rm leaves whiteouts).
	const lower = layerOf(dir, (u) => {
		writeFileSync(join(u, "a"), "old");
		mkdirSync(join(u, "d"), { mode: 0o750 });
		writeFileSync(join(u, "d", "x"), "old");
		assert.equal(spawnSync("mkfifo", [join(u, "pipe")]).status, 0);
	});
	const root = join(dir, "work", "_9");
	const work = prepareWork(dir, root, [lower]);
	if ("missing" in work) throw new Error("no work");
	for (const name of ["a", "d"]) assert.equal(spawnSync("mknod", [join(work.upper, name), "c", "0", "0"]).status, 0);
	assert.deepEqual(listIn(work, ""), ["pipe"]);
	// A write over the deleted file replaces its whiteout; one under the deleted dir makes it anew, opaque.
	writeViewFile(locate([workRoot(work)], "/w/a", true), "a", "new");
	writeViewFile(locate([workRoot(work)], "/w/d/y", true, true), "d/y", "new");
	assert.equal(readFileSync(join(work.upper, "a"), "utf8"), "new");
	assert.deepEqual(listIn(work, "d"), ["y"]);
	// The special file is in the manifest, never dropped, and survives a squash with the dir's mode.
	assert.equal(readManifest(dir, lower).pipe!.type, "special");
	const squashed = squash(dir, [lower, marked]);
	assert.ok(statSync(join(layerDir(dir, squashed), "pipe")).isFIFO());
	assert.equal(statSync(join(layerDir(dir, squashed), "d")).mode & 0o7777, 0o750);
});

test("a workspace without the xattr tools is refused before the run starts", async () => {
	const { RunRefused } = await import("../src/host/index.ts");
	// Only bash (the fixture's sandbox needs it) on the PATH, not the xattr tools.
	const bin = tmp();
	symlinkSync("/usr/bin/bash", join(bin, "bash"));
	const path = process.env.PATH;
	process.env.PATH = bin;
	try {
		await assert.rejects(runWorkflow({ ...opts(join(tmp(), "run"), "branches"), executor: worker() }), (e: unknown) => e instanceof RunRefused && e.refusal.type === "requires_missing" && (e.refusal as { name: string }).name === "getfattr");
	} finally {
		process.env.PATH = path;
	}
});
