// A workflow outside the repo: it imports wallis, wallis/executors and
// wallis/testing by package name (installed as a link, as npm does for a
// local dir), type-checks with the tsconfig `wallis doc` gives, and runs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cli, cliEnv, tmp } from "./util.ts";

const host = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("a workflow anywhere imports wallis by package name, type-checks with the documented tsconfig, and runs on a faux model", () => {
	const project = tmp("wallis-outside-");
	writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }));
	mkdirSync(join(project, "node_modules"));
	symlinkSync(host, join(project, "node_modules", "wallis"));
	symlinkSync(join(host, "node_modules", "@types"), join(project, "node_modules", "@types"));
	writeFileSync(
		join(project, "workflow.ts"),
		`import prompt from "./prompt.md" with { type: "text" };
import { defineAgent, defineModels, Type, workflow } from "wallis";
const models = defineModels({ default: "faux/faux-1" });
const greeter = defineAgent({ models }, { name: "greeter", model: "default", prompt, input: Type.Null(), output: Type.Object({ hello: Type.String() }) });
export default workflow({ name: "outside", models, agents: [greeter], input: Type.Null(), output: Type.Any(), run: async (ctx) => (await ctx.call(ctx.session(greeter), null))[0] });
`,
	);
	writeFileSync(join(project, "prompt.md"), "Say hello.");
	writeFileSync(
		join(project, "executor.ts"),
		`import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, PiExecutor } from "wallis/testing";
import type { ExecutorKit } from "wallis/executors";
export default function create(): ExecutorKit {
	const provider = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(provider.provider);
	provider.setResponses([fauxAssistantMessage([fauxToolCall("submit_result", { hello: "world" })], { stopReason: "toolUse" })]);
	return { executor: new PiExecutor({ models }) };
}
`,
	);
	// The tsconfig exactly as `wallis doc` gives it.
	const doc = readFileSync(join(host, "src", "cli", "doc.md"), "utf8");
	const tsconfig = /A minimal `tsconfig.json`[\s\S]*?```json\n([\s\S]*?)```/.exec(doc)![1]!;
	writeFileSync(join(project, "tsconfig.json"), tsconfig);
	const tsc = spawnSync(process.execPath, [join(host, "node_modules", "typescript", "bin", "tsc"), "-p", project], { encoding: "utf8" });
	assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
	const run = spawnSync(process.execPath, [cli, "run", join(project, "workflow.ts"), "--executor", join(project, "executor.ts"), "--json", "--root", project], { encoding: "utf8", env: cliEnv(), cwd: project, timeout: 60_000 });
	assert.equal(run.status, 0, run.stderr);
	const result = JSON.parse(run.stdout.trim()) as { status: { type: string; outcome?: unknown } };
	assert.deepEqual(result.status, { type: "finished", outcome: { type: "done", value: { hello: "world" } } });
});
