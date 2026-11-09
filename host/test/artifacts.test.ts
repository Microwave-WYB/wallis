// Artifacts, per-call dirs, mounts and the bwrap sandboxes: commands run
// for real here, so the file is skipped without bubblewrap.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { blobPath } from "../src/host/artifacts.ts";
import { bwrapAvailable, EventLog, exportArtifact, FakeExecutor, forkRun, ProcessCommands, readMeta, RunRefused, runPaths, runWorkflow, Sandboxes } from "../src/host/index.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const workflow = resolve(here, "fixtures/artifacts/workflow.ts");
const hasBwrap = bwrapAvailable();
const skip = !hasBwrap && "bubblewrap cannot create a sandbox here";
// Mount file hashes and setup envs go to a throwaway cache.
process.env.XDG_CACHE_HOME = tmp("wallis-cache-");
if (!hasBwrap) process.stderr.write("artifacts.test: bubblewrap cannot create a sandbox here; these tests are skipped\n");

/** Real binaries for the sandboxes: node is this process's own. */
const bins = { node: process.execPath, bash: "/usr/bin/bash" };

function setup() {
	const root = tmp("wallis-artifacts-");
	const corpus = join(root, "corpus");
	mkdirSync(corpus);
	writeFileSync(join(corpus, "words.txt"), "corpus");
	const outside = join(root, "secret.txt");
	writeFileSync(outside, "secret");
	return { root, corpus, outside, dir: join(root, ".wallis", "runs", "r1") };
}

function writer() {
	return new FakeExecutor({
		writer: (call) => {
			// The checkpoint is an input artifact; the report is written to scratch and exported.
			const ref = call.input as { checkpoint: { digest: string; name: string } };
			const ckpt = readFileSync(join(call.workspace.inputs, ref.checkpoint.digest.slice(7), ref.checkpoint.name), "utf8");
			assert.equal(call.sandbox.type, "bwrap");
			writeFileSync(join(call.workspace.scratch, "report.md"), `# Report\n${ckpt}\n`);
			return { submit: { report: call.exportArtifact("report.md", "text/markdown") } };
		},
	});
}

async function run(s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) {
	return runWorkflow({
		workflow,
		dir: s.dir,
		root: s.root,
		executor: writer(),
		commands: new ProcessCommands(),
		confine: "require",
		bins,
		input: { outside: s.outside },
		mounts: { corpus: s.corpus },
		local: {},
		inboxPollMs: null,
		...extra,
	});
}

test("artifacts flow between commands and agents by ref; argv and parse are typed adapters; call dirs are discarded", { skip }, async () => {
	const s = setup();
	const r = await run(s);
	assert.equal(r.outcome?.type, "done", JSON.stringify(r.status));
	const out = (r.outcome as unknown as { value: Record<string, { digest: string; name: string; media: string }> & { size: number; missing: unknown } }).value;
	assert.deepEqual(Object.keys(out.model!).sort(), ["digest", "media", "name"]);
	assert.equal(readFileSync(blobPath(s.dir, out.model!.digest), "utf8"), "weights");
	// train got the model's mounted path in its argv and the corpus mount; parse took its stdout and a file.
	assert.equal(readFileSync(blobPath(s.dir, out.checkpoint!.digest), "utf8"), "weights+corpus");
	assert.equal(out.size, "weights".length + "corpus".length);
	assert.equal(readFileSync(blobPath(s.dir, out.report!.digest), "utf8"), "# Report\nweights+corpus\n");
	// A file parse names that the command never wrote: typed, not silent.
	assert.deepEqual(out.missing, { type: "missing_file", name: "nothing.bin" });
	const log = readFileSync(join(s.dir, "log.jsonl"), "utf8");
	assert.doesNotMatch(log, /"artifact":/);
	assert.doesNotMatch(log, /not-exported/);
	// Calls' dirs are discarded; only the writer session's scratch dir stays, cleaned with the run.
	const left = existsSync(join(s.dir, "work")) ? readdirSync(join(s.dir, "work")) : [];
	assert.equal(left.length, 1);
	assert.match(left[0]!, /^lineage-[0-9a-f]{16}$/);
	assert.deepEqual(readdirSync(join(s.dir, "work", left[0]!)), ["scratch"]);
	const started = new EventLog(join(s.dir, "log.jsonl")).read()[0] as { pin: { inputs: Record<string, string> } };
	assert.match(started.pin.inputs["mount.corpus"]!, /^mount:sha256:[0-9a-f]{64}$/);
	// Run metadata: resolved binaries with versions, and the base.
	const meta = readMeta(runPaths(s.dir))!;
	assert.equal(meta.bins!.node!.path, process.execPath);
	assert.match(meta.bins!.node!.version ?? "", /^v\d+/);
	assert.ok(meta.base!.kernel.length > 0);
	assert.equal(meta.confined, true);

	const target = tmp();
	assert.equal(readFileSync(exportArtifact(s.dir, "report.md", target), "utf8"), "# Report\nweights+corpus\n");
	const fork = forkRun(s.dir, join(s.root, ".wallis", "runs", "r2"));
	assert.equal(statSync(blobPath(fork.dir, out.model!.digest)).ino, statSync(blobPath(s.dir, out.model!.digest)).ino, "hardlinked, not copied");
});

test("nothing is implicit: a command sees its mounts read-only, its inputs, its scratch dir, and nothing else", { skip }, async () => {
	const s = setup();
	const r = await run(s);
	const probed = (r.outcome as unknown as { value: { probed: Record<string, boolean> } }).value.probed;
	const { writes_outside: _private, ...rest } = probed;
	assert.deepEqual(rest, { reads_input: true, writes_input: false, writes_scratch: true, reads_outside: false, sees_home: false, sees_workflow_dir: false, writes_mount: false });
	assert.ok(!existsSync(`${s.outside}.copy`));
});

test("a changed mount is a result-defining change: resume refuses it", { skip }, async () => {
	const s = setup();
	await run(s);
	writeFileSync(join(s.corpus, "words.txt"), "a different corpus");
	await assert.rejects(run(s), (e: unknown) => e instanceof RunRefused && e.refusal.type === "pin_mismatch" && e.refusal.field === "inputs.mount.corpus");
});

test("requires: a missing binary, a broken one (a lone shim), an undeclared --bin are typed refusals", { skip }, async () => {
	const s = setup();
	const refusal = (bins: Record<string, string>, path = "/nonexistent") =>
		run(s, { bins, callerPath: path }).then(
			() => null,
			(e: unknown) => (e instanceof RunRefused ? e.refusal : e),
		);
	assert.deepEqual(await refusal({ bash: "/usr/bin/bash" }), { type: "requires_missing", name: "node" });
	assert.deepEqual(await refusal({ ...bins, uvx: "/bin/true" }), { type: "unknown_bin", name: "uvx" });
	// A script bound alone at /run/wallis/bin/node cannot reach what it needs: broken.
	const shim = join(tmp(), "node");
	writeFileSync(shim, "#!/bin/sh\nexec /opt/elsewhere/node \"$@\"\n");
	chmodSync(shim, 0o755);
	const broken = (await refusal({ ...bins, node: shim })) as { type: string; name: string; exit: number };
	assert.equal(broken.type, "requires_broken");
	assert.equal(broken.name, "node");
	assert.notEqual(broken.exit, 0);
	// The caller's PATH resolves what is not given.
	assert.equal(await refusal({ bash: "/usr/bin/bash" }, `${resolve(process.execPath, "..")}:/usr/bin`), null);
});

test("setup runs once per digest with the network on, writes $WALLIS_ENV, and its binaries are smoke-tested", { skip }, async () => {
	const decls = {
		env: {
			requires: [{ name: "bash", check: ["bash", "--version"] }],
			setup: [["bash", "-c", 'mkdir -p "$WALLIS_ENV/bin" && printf "#!/bin/sh\\necho tool 1.0\\n" > "$WALLIS_ENV/bin/tool" && chmod +x "$WALLIS_ENV/bin/tool" && date +%N > "$WALLIS_ENV/stamp"']],
			mounts: [],
			network: [],
			base: null,
		},
	};
	const cacheDir = tmp("wallis-envs-");
	const make = () => new Sandboxes({ decls, bins: { bash: "/usr/bin/bash" }, mounts: {}, mountDigests: {}, cacheDir });
	const notes: string[] = [];
	make().prepare((t) => notes.push(t));
	const dirs = readdirSync(cacheDir);
	assert.equal(dirs.length, 1);
	const stamp = readFileSync(join(cacheDir, dirs[0]!, "stamp"), "utf8");
	make().prepare((t) => notes.push(t));
	assert.equal(readFileSync(join(cacheDir, dirs[0]!, "stamp"), "utf8"), stamp, "cached by digest: not run again");
	assert.equal(notes.filter((n) => n.startsWith("setup of sandbox env")).length, 1);
	// A setup binary that does not run fails the setup, typed.
	const bad = { env: { ...decls.env, setup: [["bash", "-c", 'mkdir -p "$WALLIS_ENV/bin" && printf "#!/opt/none/sh\\n" > "$WALLIS_ENV/bin/shim" && chmod +x "$WALLIS_ENV/bin/shim"']] } };
	assert.throws(
		() => new Sandboxes({ decls: bad, bins: { bash: "/usr/bin/bash" }, mounts: {}, mountDigests: {}, cacheDir }).prepare(),
		(e: unknown) => (e as { refusal?: { type: string } }).refusal?.type === "setup_failed",
	);
});

test("a session's scratch dir outlives its calls; a done call's own dir is deleted", { skip }, async () => {
	const s = setup();
	const executor = () =>
		new FakeExecutor({
			writer: (call) => {
				if (call.transcript.length === 0) {
					writeFileSync(join(call.workspace.scratch, "draft.md"), "draft");
					return { idle: "Should the report be short?" };
				}
				const draft = readFileSync(join(call.workspace.scratch, "draft.md"), "utf8");
				writeFileSync(join(call.workspace.scratch, "report.md"), `${draft}, short`);
				return { submit: { report: call.exportArtifact("report.md", "text/markdown") } };
			},
		});
	const idle = await run(s, { executor: executor() });
	const node = idle.run.nodes.find((n) => n.type === "node_idle")!;
	// The session's lineage keeps one scratch dir (named by its first call's slot).
	const lineage = readdirSync(join(s.dir, "work")).filter((d) => d.startsWith("lineage-"));
	assert.equal(lineage.length, 1);
	const scratch = join(s.dir, "work", lineage[0]!, "scratch");
	const own = join(s.dir, "work", node.id.replace(/[^A-Za-z0-9._-]/g, "_"));
	assert.equal(readFileSync(join(scratch, "draft.md"), "utf8"), "draft");
	assert.ok(existsSync(own));
	const done = await run(s, { executor: executor(), sends: [{ node: node.id, text: "yes" }] });
	const report = (done.outcome as unknown as { value: { report: { digest: string } } }).value.report;
	assert.equal(readFileSync(blobPath(s.dir, report.digest), "utf8"), "draft, short");
	assert.ok(existsSync(join(scratch, "report.md")), "the session's scratch dir stays");
	assert.ok(!existsSync(own), "the call's own dir is gone");
});
