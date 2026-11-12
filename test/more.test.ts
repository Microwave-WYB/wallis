// The parts the examples leave untested: an MCP server's tools (called by a body and given to an
// agent), ctx.loop (each iteration a branch), and an agent returning a workspace file as an Artifact.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runPaths, runsDir } from "../src/host/runs.ts";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { run } from "../src/index.ts";
import { RunView } from "../src/status.ts";
import { faux, messages, text } from "./fixtures/faux.ts";
import { here, project } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

async function fixture() {
	const root = project(
		{ "wf.ts": readFileSync(join(here, "fixtures/more.ts"), "utf8"), "srv/mcp-server.mjs": readFileSync(join(here, "fixtures/mcp-server.mjs"), "utf8") },
		{ models: { default: "faux/m" }, executor: join(here, "fixtures/faux.ts") },
	);
	return { root, wf: (await import(pathToFileURL(join(root, "wf.ts")).href)) as typeof import("./fixtures/more.ts") };
}

test("an MCP server in its sandbox: a body calls one of its tools (structured result), an agent uses another", opts, async () => {
	const { root, wf } = await fixture();
	faux.setResponses([
		(ctx) => {
			assert.ok(JSON.stringify(ctx).includes("mcp__probe__shout"), "the agent has the server's tool");
			return call("mcp__probe__shout", { text: "hello there" });
		},
		(ctx) => {
			assert.equal(text(messages(ctx).at(-1)).split("\n")[0], "HELLO THERE");
			return call("submit_result", { result: { loud: "HELLO THERE" } });
		},
	]);
	const r = await run(wf.withMcp, { text: "hello there" });
	assert.deepEqual(r.output, { words: 2, loud: "HELLO THERE" });
	const v = new RunView(runPaths(join(runsDir(root), r.id)));
	// The body's tool call is journaled; read-only, so it may be made again on resume.
	const tool = v.calls.find((c) => c.kind === "tool")!;
	assert.deepEqual(tool.attempts, [{ type: "answered", output: { words: 2 } }]);
	assert.ok(v.events.some((e) => e.type === "requested" && e.request.type === "tool_call" && e.request.replay_safe));
});

test("ctx.loop: a typed fold whose iterations are branches; the same call in two iterations is two calls", opts, async () => {
	const { root, wf } = await fixture();
	const r = await run(wf.counting, { until: 3 });
	assert.deepEqual(r.output, { n: 3, steps: 3 });
	const v = new RunView(runPaths(join(runsDir(root), r.id)));
	const ones = v.calls.filter((c) => c.name.startsWith("one"));
	assert.equal(ones.length, 3, "one({}) in each of three iterations: three journal entries, not hits");
	assert.equal(new Set(ones.map((c) => c.scope)).size, 3);
});

test("an agent returns a file it wrote in its workspace as an Artifact", opts, async () => {
	const { wf } = await fixture();
	faux.setResponses([() => call("write", { path: "notes/report.md", content: "# Film\n\nPortra 160.\n" }), () => call("submit_result", { result: { report: "/w/notes/report.md" } })]);
	const r = await run(wf.writing, { topic: "film" });
	assert.equal(r.output.report.name, "report.md");
	assert.equal(r.output.report.media, "text/markdown");
	assert.equal(readFileSync(r.output.report.path, "utf8"), "# Film\n\nPortra 160.\n");
});
