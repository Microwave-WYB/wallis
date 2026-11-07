// Artifacts, per-node dirs, mounted datasets and the bwrap script sandbox.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { blobPath } from "../src/host/artifacts.ts";
import { EventLog, exportArtifact, FakeExecutor, forkRun, RunRefused, runWorkflow } from "../src/host/index.ts";
import { bwrapAvailable, ProcessScripts } from "../src/host/scripts.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const workflow = resolve(here, "fixtures/artifacts/workflow.ts");
const hasBwrap = bwrapAvailable();
if (!hasBwrap) process.stderr.write("artifacts.test: bubblewrap cannot create a sandbox here; confinement assertions are skipped\n");

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
			// The checkpoint is mounted read-only; the report is written to scratch and exported.
			const ref = call.input as { checkpoint: { digest: string; name: string } };
			const ckpt = readFileSync(join(call.workspace.inputs, ref.checkpoint.digest.slice(7), ref.checkpoint.name), "utf8");
			writeFileSync(join(call.workspace.scratch!, "report.md"), `# Report\n${ckpt}\n`);
			return { submit: { report: call.exportArtifact("report.md", "text/markdown") } };
		},
	});
}

async function run(s: ReturnType<typeof setup>) {
	const scripts = new ProcessScripts({ workflowDir: resolve(workflow, ".."), confine: hasBwrap ? "require" : "off" });
	return runWorkflow({ workflow, dir: s.dir, root: s.root, executor: writer(), scripts, input: { outside: s.outside }, local: { data: { corpus: s.corpus } }, inboxPollMs: null });
}

test("artifacts flow downstream by ref; the store is content-addressed; node dirs are discarded", async () => {
	const s = setup();
	const r = await run(s);
	assert.equal(r.outcome?.type, "done", JSON.stringify(r.status));
	const out = (r.outcome as unknown as { value: Record<string, { digest: string; name: string; media: string }> }).value;
	assert.deepEqual(Object.keys(out.model!).sort(), ["digest", "media", "name"]);
	assert.equal(out.model!.media, "text/plain");
	assert.equal(readFileSync(blobPath(s.dir, out.model!.digest), "utf8"), "weights");
	// train received the model artifact and the mounted dataset.
	assert.equal(readFileSync(blobPath(s.dir, out.checkpoint!.digest), "utf8"), "weights+corpus");
	assert.equal(readFileSync(blobPath(s.dir, out.report!.digest), "utf8"), "# Report\nweights+corpus\n");
	// The log carries refs only; files not exported are gone with their node dirs.
	const log = readFileSync(join(s.dir, "log.jsonl"), "utf8");
	assert.doesNotMatch(log, /"artifact":/);
	assert.doesNotMatch(log, /not-exported/);
	assert.deepEqual(existsSync(join(s.dir, "work")) ? readdirSync(join(s.dir, "work")) : [], []);
	// The dataset's manifest digest is pinned.
	const started = new EventLog(join(s.dir, "log.jsonl")).read()[0] as { pin: { inputs: Record<string, string> } };
	assert.match(started.pin.inputs["data.corpus"]!, /^manifest:sha256:[0-9a-f]{64}$/);

	// export copies an artifact out; fork shares blobs.
	const target = tmp();
	assert.equal(readFileSync(exportArtifact(s.dir, "report.md", target), "utf8"), "# Report\nweights+corpus\n");
	assert.equal(readFileSync(exportArtifact(s.dir, out.model!.digest.slice(7, 19), target), "utf8"), "weights");
	const fork = forkRun(s.dir, join(s.root, ".wallis", "runs", "r2"), 3);
	assert.equal(statSync(blobPath(fork.dir, out.model!.digest)).ino, statSync(blobPath(s.dir, out.model!.digest)).ino, "hardlinked, not copied");
});

test("scripts run confined: read-only inputs, a private scratch dir, nothing else", { skip: !hasBwrap && "bubblewrap unavailable" }, async () => {
	const s = setup();
	const r = await run(s);
	const probed = (r.outcome as unknown as { value: { probed: Record<string, boolean> } }).value.probed;
	const { writes_outside: _private, ...rest } = probed;
	assert.deepEqual(rest, { reads_input: true, writes_input: false, writes_scratch: true, reads_outside: false, sees_home: false });
	// The sandbox's /tmp is a private tmpfs: a write there never reaches the host.
	assert.ok(!existsSync(`${s.outside}.copy`));
});

test("a changed dataset is a result-defining change: resume refuses it", async () => {
	const s = setup();
	await run(s);
	writeFileSync(join(s.corpus, "words.txt"), "a different corpus");
	await assert.rejects(run(s), (e: unknown) => e instanceof RunRefused && e.refusal.type === "pin_mismatch" && e.refusal.field === "inputs.data.corpus");
});

test("an idle node keeps its scratch dir; a done node's dir is deleted", async () => {
	const s = setup();
	const scripts = new ProcessScripts({ workflowDir: resolve(workflow, ".."), confine: hasBwrap ? "require" : "off" });
	const executor = () =>
		new FakeExecutor({
			writer: (call) => {
				if (call.transcript.length === 0) {
					writeFileSync(join(call.workspace.scratch!, "draft.md"), "draft");
					return { idle: "Should the report be short?" };
				}
				const draft = readFileSync(join(call.workspace.scratch!, "draft.md"), "utf8");
				writeFileSync(join(call.workspace.scratch!, "report.md"), `${draft}, short`);
				return { submit: { report: call.exportArtifact("report.md", "text/markdown") } };
			},
		});
	const opts = { workflow, dir: s.dir, root: s.root, scripts, local: { data: { corpus: s.corpus } }, inboxPollMs: null } as const;
	const idle = await runWorkflow({ ...opts, executor: executor(), input: { outside: s.outside } });
	const node = idle.run.nodes.find((n) => n.agent === "writer")!;
	assert.equal(node.status.type, "node_idle");
	const scratch = join(s.dir, "work", node.id.replace(/[^A-Za-z0-9._-]/g, "_"), "scratch");
	assert.equal(readFileSync(join(scratch, "draft.md"), "utf8"), "draft");
	const done = await runWorkflow({ ...opts, executor: executor(), sends: [{ node: node.id, text: "yes" }] });
	const report = (done.outcome as unknown as { value: { report: { digest: string } } }).value.report;
	assert.equal(readFileSync(blobPath(s.dir, report.digest), "utf8"), "draft, short");
	assert.ok(!existsSync(scratch));
});
