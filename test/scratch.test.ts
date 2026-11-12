// A call's scratch dir: its own for every call (also identical ones at once), removable whatever
// the command left in it, never a way out to host files; and stdout decoded as one stream.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { NodeFailed, run } from "../src/index.ts";
import { faux } from "./fixtures/faux.ts";
import { here, project, tmp } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

async function fixture() {
	const root = project({ "wf.ts": readFileSync(join(here, "fixtures/scratch.ts"), "utf8") }, { models: { default: "faux/m" }, executor: join(here, "fixtures/faux.ts") });
	return { root, wf: (await import(pathToFileURL(join(root, "wf.ts")).href)) as typeof import("./fixtures/scratch.ts") };
}

test("identical calls at once each get their own scratch dir (commands)", opts, async () => {
	const { root, wf } = await fixture();
	const r = await run(wf.vote, {});
	assert.notEqual(r.output.a.digest, r.output.b.digest, "two random samples");
	assert.ok(!existsSync(join(root, ".wallis/runs", r.id, "work")), "the call dirs, and then work/, are removed afterwards");
});

test("identical agent calls at once each get their own workspace (majority voting)", opts, async () => {
	const { wf } = await fixture();
	let n = 0;
	faux.setResponses(
		[1, 2, 3].flatMap(() => [() => call("write", { path: "vote.txt", content: `vote ${++n}\n` })]).concat([1, 2, 3].map(() => () => call("submit_result", { result: { vote: "/w/vote.txt" } }))),
	);
	const r = await run(wf.votes, {});
	const texts = r.output.votes.map((v) => readFileSync(v.path, "utf8")).sort();
	assert.deepEqual(texts, ["vote 1\n", "vote 2\n", "vote 3\n"]);
});

test("a command that leaves read-only dirs in /w does not crash the run", opts, async () => {
	const { wf } = await fixture();
	assert.deepEqual((await run(wf.modcache, {})).output, { ok: true });
});

test("r.file through a symlink out of /w is refused with a clear error, and the host file is never moved", opts, async () => {
	const { wf } = await fixture();
	const host = tmp();
	writeFileSync(join(host, "result.txt"), "the host's own file\n");
	await assert.rejects(run(wf.leaking, { host, name: "result.txt" }), (e: unknown) => e instanceof NodeFailed && e.reason.type === "output_invalid" && /leaves the command's scratch dir/.test(e.reason.errors.join(" ")));
	assert.equal(readFileSync(join(host, "result.txt"), "utf8"), "the host's own file\n");
});

test("a symlink inside /w is followed and what it names is copied, not moved", opts, async () => {
	const { wf } = await fixture();
	const r = await run(wf.aliased, {});
	assert.equal(readFileSync(r.output.f.path, "utf8"), "inside\n");
	assert.equal(r.output.f.name, "x.txt");
	assert.equal((r.output.d as { kind: string }).kind, "tree");
});

test("long multibyte stdout is decoded as one stream", opts, async () => {
	const { wf } = await fixture();
	const r = await run(wf.multibyte, {});
	assert.equal(r.output.text.length, 200_000);
	assert.ok(!r.output.text.includes("�"));
	void existsSync;
	void mkdirSync;
});
