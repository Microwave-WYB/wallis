// Runs (or resumes) the two-node example with the fake executor.
//
//   node examples/two-node/run.ts --log run.jsonl [--exec-log exec.jsonl] [--kill-on writer]
//
// --exec-log records every call the executor starts. --kill-on SIGKILLs
// this process while that agent's call is in flight. Prints the result.

import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FakeExecutor, runWorkflow } from "../../src/host/index.ts";

const { values } = parseArgs({ options: { log: { type: "string" }, "exec-log": { type: "string" }, "kill-on": { type: "string" } } });
if (!values.log) throw new Error("--log is required");

export const responses = {
	planner: { output: { outline: ["why", "how", "so what"], note: "outline has three points" } },
	writer: { output: { text: "Why. How. So what.", words: 4 } },
};

const executor = new FakeExecutor(responses, {
	onCall: (call) => {
		if (values["exec-log"]) appendFileSync(values["exec-log"], `${JSON.stringify({ id: call.id, agent: call.agent })}\n`);
		if (call.agent === values["kill-on"]) process.kill(process.pid, "SIGKILL");
	},
});

const result = await runWorkflow({
	workflow: resolve(dirname(fileURLToPath(import.meta.url)), "workflow.ts"),
	log: values.log,
	executor,
	input: { topic: "folding products" },
	seed: 42,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
