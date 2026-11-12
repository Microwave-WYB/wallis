// The package as npm (and a git install, which runs `prepare`) delivers it: `npm pack` builds
// dist/ and ships it with the core's JavaScript (core/dist) and the skill, not the sources' tests.
// Installed into a real node_modules (where Node does not strip types), it runs a workflow.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { here, tmp } from "./util.ts";

const root = join(here, "..");
const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
// Inside the repo, so the installed package's dependencies resolve from the repo's node_modules.
mkdirSync(join(root, ".wallis"), { recursive: true });
const project = mkdtempSync(join(root, ".wallis", "pkgtest-"));
after(() => rmSync(project, { recursive: true, force: true }));

test("npm pack ships dist, core/dist and the skill; installed, it runs a workflow", { skip, timeout: 240_000 }, () => {
	const out = tmp();
	const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", out], { cwd: root, encoding: "utf8", timeout: 200_000 });
	assert.equal(packed.status, 0, packed.stderr);
	const [info] = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
	const files = info!.files.map((f) => f.path);
	for (const f of ["dist/index.js", "dist/index.d.ts", "dist/runner.js", "dist/host/toolset-runner.js", "core/dist/wallis_core/wallis_core.mjs", "core/dist/gleam_stdlib/gleam.mjs", "skills/wallis/SKILL.md", "README.md", "LICENSE"]) assert.ok(files.includes(f), `ships ${f}`);
	assert.ok(!files.some((f) => f.startsWith("test/") || f.startsWith("src/") || f.startsWith("core/src/")), "no sources or tests");
	const pkg = join(project, "node_modules", "wallis");
	mkdirSync(pkg, { recursive: true });
	assert.equal(spawnSync("tar", ["-xzf", join(out, info!.filename), "-C", pkg, "--strip-components=1"]).status, 0);
	writeFileSync(join(project, "package.json"), '{ "type": "module" }\n');
	// The workflow's module, and a caller script apart from it (a detached run imports the module).
	writeFileSync(
		join(project, "wf.ts"),
		`import { command, sandbox, Type, workflow } from "wallis";
const twice = command({ sandbox: sandbox({ requires: ["sh"] }), input: Type.Object({ n: Type.Integer() }), output: Type.Object({ n: Type.Integer() }),
	run: (i) => ["sh", "-c", 'printf \\'{"n": %d}\\' $(( $1 * 2 ))', "sh", String(i.n)] });
export const main = workflow({ input: Type.Object({ n: Type.Integer() }), output: Type.Object({ n: Type.Integer() }), run: async (ctx, i) => ctx.call(twice, i) });
`,
	);
	writeFileSync(
		join(project, "go.ts"),
		`import { run } from "wallis";
import { main } from "./wf.ts";
const r = await run(main, { n: 21 });
const d = await run(main, { n: 2 }, { detach: true });
console.log(JSON.stringify({ fg: r.output, detached: await d.next({ timeout: "30s" }) }));
`,
	);
	const ran = spawnSync(process.execPath, ["go.ts"], { cwd: project, encoding: "utf8", timeout: 120_000 });
	assert.equal(ran.status, 0, ran.stderr);
	assert.deepEqual(JSON.parse(ran.stdout.trim()), { fg: { n: 42 }, detached: { type: "finished", output: { n: 4 } } });
});
