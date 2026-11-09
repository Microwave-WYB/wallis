// Tool names: what an agent sees is unique. A custom or MCP tool named like
// a built-in, or two tools by one name (two exports, two toolsets), are
// refused before the run starts (`tool_name_taken`), never one replacing
// the other; a toolset serves each tool under its export name, so two
// exports that share a name each reach their own code.

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeExecutor, RunRefused, runWorkflow } from "../src/host/index.ts";
import { NodeTools } from "../src/host/tools.ts";
import { resolveAgentTools, type ToolInfo, toolInfos } from "../src/host/toolsets.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = (file: string) => resolve(here, "fixtures/names", file);
const opts = (workflow: string) => ({ workflow, dir: join(tmp(), "run"), input: null, executor: new FakeExecutor({}), inboxPollMs: null, confine: "off" as const });

test("two exports of a toolset that share a name each reach their own code from the body", async () => {
	const done = await runWorkflow(opts(fixture("workflow.ts")));
	assert.deepEqual(done.outcome, { type: "done", value: { first: "first", second: "second" } });
});

for (const [file, agent, name] of [
	["builtin.ts", "builtin", "read"],
	["exports.ts", "exports", "dup"],
	["sources.ts", "sources", "search"],
] as const) {
	test(`an agent's tool name that is taken is refused before the run starts: ${file}`, async () => {
		await assert.rejects(runWorkflow(opts(fixture(file))), (e: unknown) => {
			assert.ok(e instanceof RunRefused, String(e));
			assert.deepEqual(e.refusal, { type: "tool_name_taken", agent, name });
			return true;
		});
	});
}

test("the name check is on the listing too, and a second tool by one name is never added", () => {
	const listed = (path: string, tools: { name: string; export: string }[]): ToolInfo[] =>
		toolInfos(
			{ kind: "toolset", path },
			tools.map((t) => ({ name: t.export, _meta: { "wallis/name": t.name } })),
		);
	const listing = new Map([
		["toolset:./a.ts", listed("./a.ts", [{ name: "submit_result", export: "submit" }, { name: "x", export: "x" }])],
		["toolset:./b.ts", listed("./b.ts", [{ name: "x", export: "x" }])],
	]);
	const resolved = (exports: [string, string][]) =>
		resolveAgentTools(
			"a",
			exports.map(([toolset, e]) => ({ kind: "custom", toolset, export: e })),
			listing,
		).taken;
	assert.equal(resolved([["./a.ts", "submit"]]), "submit_result");
	assert.equal(resolved([["./a.ts", "x"], ["./b.ts", "x"]]), "x");
	assert.equal(resolved([["./a.ts", "x"]]), null);
	const tools = new NodeTools({ agent: "a" } as never, 1, 1);
	tools.add({ name: "x", description: "", parameters: {}, run: async () => ({ text: "" }) });
	assert.throws(() => tools.add({ name: "x", description: "", parameters: {}, run: async () => ({ text: "" }) }), /tool_name_taken/);
});
