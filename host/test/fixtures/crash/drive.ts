// Drives the pi fixture workflow on pi-ai's faux provider and SIGKILLs
// itself when the model is asked for turn `--kill-at` (the turns before it
// are complete and checkpointed). Used by the durability test.
//
//   node test/fixtures/crash/drive.ts <run dir> <kill at turn>

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiExecutor, runWorkflow } from "../../../src/host/index.ts";

const [dir, killAt] = process.argv.slice(2);
const provider = fauxProvider({ models: [{ id: "faux-1" }] });
const models = createModels();
models.setProvider(provider.provider);
let turn = 0;
const step = () => {
	turn++;
	if (turn === Number(killAt)) process.kill(process.pid, "SIGKILL");
	return fauxAssistantMessage([fauxToolCall("codemode", { code: `return ${turn};` } as never)], { stopReason: "toolUse" });
};
provider.setResponses([step, step, step, step, step]);
await runWorkflow({
	workflow: resolve(fileURLToPath(new URL(".", import.meta.url)), "../pi/workflow.ts"),
	dir: dir!,
	executor: new PiExecutor({ models }),
	confine: "off",
	input: { topic: "t", notes: [] },
	inboxPollMs: null,
});
