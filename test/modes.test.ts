// Store files keep the modes they were written with (protection is the sandbox's read-only mounts),
// and read-only dirs a command or an agent leaves still enter the store; a file and its dir both kept.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { readManifest } from "../src/host/layers.ts";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { Store } from "../src/host/store.ts";
import { run, Tree } from "../src/index.ts";
import { faux } from "./fixtures/faux.ts";
import { here, project } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const opts = { skip, timeout: 60_000 };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

async function fixture() {
	const root = project({ "wf.ts": readFileSync(join(here, "fixtures/modes.ts"), "utf8") }, { models: { default: "faux/m" }, executor: join(here, "fixtures/faux.ts") });
	return { root, wf: (await import(pathToFileURL(join(root, "wf.ts")).href)) as typeof import("./fixtures/modes.ts") };
}

const modes = (root: string, tree: { digest: string }) => {
	const store = new Store(root);
	const out: Record<string, number> = {};
	for (const layer of store.treeLayers(tree.digest)!) for (const [p, e] of Object.entries(readManifest(store.dir, layer))) if ("mode" in e) out[p] = e.mode & 0o7777;
	return out;
};

test("a command copies an input Tree into /w and edits a copied file in place; the modes stay faithful", opts, async () => {
	const { root, wf } = await fixture();
	const src = join(root, "pkg");
	mkdirSync(join(src, "bin"), { recursive: true });
	writeFileSync(join(src, "package.json"), "{}\n");
	writeFileSync(join(src, "bin", "run"), "#!/bin/sh\n");
	chmodSync(join(src, "bin", "run"), 0o755);
	const t = Tree.from(src);
	const r = await run(wf.patched, { t });
	assert.equal(readFileSync(join(r.output.out.path, "package.json"), "utf8"), "{}\npatched\n");
	assert.deepEqual(modes(root, r.output.out), { bin: 0o755, "bin/run": 0o755, "package.json": 0o644 });
	// The store's files keep those modes: nothing there was made read-only.
	assert.equal(statSync(join(r.output.out.path, "package.json")).mode & 0o777, 0o644);
	assert.equal(statSync(join(r.output.out.path, "bin", "run")).mode & 0o777, 0o755);
});
