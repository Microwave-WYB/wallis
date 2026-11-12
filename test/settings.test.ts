// No silent substitutions: an unknown model alias, an author's PATH and HOME, named volumes per
// project and serialized, an author volume at /out, the bash tool's timeout.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { bwrapAvailable, resolvePrograms, runSpawn, sandboxed } from "../src/host/sandbox.ts";
import { namedVolumesDir, resolveVolumes } from "../src/host/volumes.ts";
import { NodeFailed, run, sandbox } from "../src/index.ts";
import { faux, messages, text } from "./fixtures/faux.ts";
import { here, project, tmp } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

async function fixture() {
	const root = project({ "wf.ts": readFileSync(join(here, "fixtures/settings.ts"), "utf8") }, { models: { default: "faux/m", fast: "faux/m" }, executor: join(here, "fixtures/faux.ts") });
	return { root, wf: (await import(pathToFileURL(join(root, "wf.ts")).href)) as typeof import("./fixtures/settings.ts") };
}

test("an unknown model alias is an error that names the known ones", opts, async () => {
	const { wf } = await fixture();
	await assert.rejects(run(wf.unknownAlias, {}), (e: unknown) => e instanceof NodeFailed && /model alias nope is not configured.*known: default, fast/.test(e.message));
});

test("an author's PATH is prepended to wallis's; an author's HOME is refused, saying why", { skip }, async () => {
	const w = join(tmp(), "w");
	(await import("node:fs")).mkdirSync(w);
	const r = await runSpawn(sandboxed({ programs: resolvePrograms(["sh"]), volumes: [], environment: { PATH: "/opt/venv/bin" }, devices: [], network: "none" }, ["sh", "-c", 'echo "$PATH"'], { work: { kind: "dir", dir: w }, inputs: [], trees: [] }), "");
	assert.match(r.stdout.trim(), /^\/opt\/venv\/bin:.*\/usr\/bin/);
	assert.throws(() => sandbox({ environment: { HOME: "/home/me" } }), /HOME.*sets HOME to \/w/);
});

test("named volumes are the project's: two projects never share one", () => {
	const [a, b] = [tmp(), tmp()];
	assert.notEqual(resolveVolumes(["venv:/opt/venv"], a, { root: a })[0]!.dir, resolveVolumes(["venv:/opt/venv"], b, { root: b })[0]!.dir);
	assert.equal(resolveVolumes(["venv:/opt/venv"], a, { root: a })[0]!.dir, join(namedVolumesDir(a), "venv"));
});

test("two commands writing one named volume at once are serialized", opts, async () => {
	const { root, wf } = await fixture();
	await run(wf.twoSetups, {});
	const log = readFileSync(join(namedVolumesDir(root), "env", "log"), "utf8").trim().split("\n");
	assert.deepEqual(log.map((l) => l.split(" ")[0]), ["start", "end", "start", "end"]);
});

test("an author volume at /out does not break an agent's file result; a bash command over its timeout is killed", opts, async () => {
	const { wf } = await fixture();
	faux.setResponses([
		() => call("bash", { command: "sleep 5; echo done" }),
		(ctx) => {
			const said = text(messages(ctx).at(-1));
			assert.match(said, /killed after 1 s: the bash timeout/);
			return call("write", { path: "r.txt", content: "report\n" });
		},
		() => call("submit_result", { result: { report: "/w/r.txt", said: "timed out" } }),
	]);
	const r = await run(wf.outAndTimeout, { cmd: "sleep 5" });
	assert.equal(readFileSync(r.output.report.path, "utf8"), "report\n");
});
