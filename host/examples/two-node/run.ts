// Runs (or resumes) the two-node example with the fake executor.
//
//   node examples/two-node/run.ts --dir <run dir> [--exec-log exec.jsonl] [--kill-on writer]
//
// --exec-log records every call the executor starts. --kill-on SIGKILLs
// this process while that agent's call is in flight. Prints the result.

import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FakeExecutor, runWorkflow } from "../../src/host/index.ts";

const { values } = parseArgs({ options: { dir: { type: "string" }, "exec-log": { type: "string" }, "kill-on": { type: "string" } } });
if (!values.dir) throw new Error("--dir is required");

const executor = new FakeExecutor(
	{
		planner: { submit: { outline: ["why", "how", "so what"], note: "outline has three points" } },
		writer: { submit: { text: "Why. How. So what.", words: 4 } },
	},
	{
		onCall: (call) => {
			if (values["exec-log"]) appendFileSync(values["exec-log"], `${JSON.stringify({ id: call.id, agent: call.agent })}\n`);
			if (call.agent === values["kill-on"]) process.kill(process.pid, "SIGKILL");
		},
	},
);

const result = await runWorkflow({
	workflow: resolve(dirname(fileURLToPath(import.meta.url)), "workflow.ts"),
	dir: values.dir,
	executor,
	input: { topic: "folding products" },
	seed: 42,
	inboxPollMs: null,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
