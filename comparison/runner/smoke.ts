// Wiring check on pi-ai's faux provider: sandboxed bash, read-only mounts,
// file tools, status, steering, phases. No network, no cost.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { builderArm } from "./arms.ts";
import { type Models, setModels } from "./lib/agent.pi.ts";

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const script = [
	call("bash", { command: "echo hi > /work/hello.txt && head -1 /mnt/siderius/README.md && ls /opt/node/bin && (curl -sS https://example.com || echo no-network)" }),
	call("read_file", { path: "/mnt/siderius/README.md", limit: 2 }),
	call("write_file", { path: "/mnt/siderius/x.txt", content: "nope" }),
	call("write_file", { path: "/work/NOTES.md", content: "plan: smoke" }),
	call("submit_result", { status: "done", summary: "smoke ok", test_command: "true" }),
];
const results: string[] = [];
const provider = fauxProvider({ models: [{ id: "a" }] });
const models = createModels();
models.setProvider(provider.provider);
let i = 0;
provider.setResponses(Array.from({ length: 10 }, () => (ctx: unknown) => {
	const msgs = (ctx as { messages: { role: string; content: unknown }[] }).messages;
	results.push(JSON.stringify(msgs.at(-1)?.content ?? "").slice(0, 400));
	return script[Math.min(i++, script.length - 1)]!;
}));
setModels(models as unknown as Models);

const dir = new URL("work/smoke", import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true });
const arm = builderArm("a", { model: "faux/a", workDir: dir, phases: 2, turnsPerPhase: 10 });
const out = await arm.done;
console.log(results.join("\n---\n"));
assert.equal(out?.status, "done");
assert.equal(readFileSync(`${dir}/hello.txt`, "utf8").trim(), "hi");
assert.ok(existsSync(`${dir}/NOTES.md`));
assert.ok(!existsSync("/tmp/siderius-src/SIDERIUS/x.txt"));
assert.match(results.join("\n"), /read-only/);
assert.match(results.join("\n"), /no-network/);
assert.match(results.join("\n"), /Turn \d+ of 10/);
const status = JSON.parse(readFileSync(`${dir}/status.json`, "utf8"));
assert.equal(status.state, "done");
console.log("SMOKE OK", status);
