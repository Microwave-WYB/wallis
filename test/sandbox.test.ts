// The sandbox under real bwrap (skipped with a reason without it). It must
// prevent accidents and make dependencies explicit: a call sees its inputs
// and volumes as declared, its own /w, and nothing else; no network unless
// declared. Plus the `requires` exposure rules (pure).

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bwrapAvailable, type CallView, installPrefix, programBinds, resolvePrograms, runSpawn, type SandboxPlan, sandboxed } from "../src/host/sandbox.ts";
import { Store } from "../src/host/store.ts";
import { resolveVolumes } from "../src/host/volumes.ts";
import { tmp } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bubblewrap cannot create a sandbox here";
const HOME = "/home/alice";

test("a program under $HOME, a dir in it or /opt exposes only itself; its prefix's lib/share only when safe", () => {
	assert.deepEqual(programBinds("/home/alice/.local/bin/tool", { home: HOME }), ["/home/alice/.local/bin/tool"]);
	assert.deepEqual(programBinds("/home/alice/bin/x", { home: HOME }), ["/home/alice/bin/x"]);
	assert.deepEqual(programBinds("/opt/bin/foo", { home: HOME }), ["/opt/bin/foo"]);
	assert.deepEqual(programBinds("/work/bin/tool", { home: HOME, root: "/work/project" }), ["/work/bin/tool"]);
	assert.deepEqual(programBinds("/usr/bin/python3", { home: HOME }), []);
	assert.equal(installPrefix("/opt/thing/bin/foo"), "/opt/thing");
	assert.equal(installPrefix("/opt/thing/foo"), "/opt/thing");
});

test("a required program that is not on PATH is an error naming it", () => {
	assert.throws(() => resolvePrograms(["sh", "definitely-not-a-program-xyz"]), /definitely-not-a-program-xyz/);
	assert.ok(resolvePrograms(["sh"]).sh!.startsWith("/"));
});

const plan = (over: Partial<SandboxPlan> = {}): SandboxPlan => ({ programs: resolvePrograms(["sh"]), volumes: [], environment: {}, devices: [], network: "none", ...over });

async function sh(script: string, p: SandboxPlan, view: Partial<CallView> = {}, dir = tmp()) {
	const w = join(dir, "w");
	mkdirSync(w, { recursive: true });
	const full: CallView = { work: { kind: "dir", dir: w }, inputs: [], trees: [], ...view };
	const r = await runSpawn(sandboxed(p, ["sh", "-c", script], full), "");
	return { ...r, w };
}

test("a command sees its input artifacts and Trees read-only, its own /w writable, and not the host", { skip, timeout: 30_000 }, async () => {
	const root = tmp();
	const store = new Store(root);
	const blob = store.putText("frame data");
	const t = join(root, "tree");
	mkdirSync(join(t, "sub"), { recursive: true });
	writeFileSync(join(t, "sub", "a.txt"), "A");
	symlinkSync("sub/a.txt", join(t, "rel"));
	symlinkSync(join(root, "secret.txt"), join(t, "abs"));
	writeFileSync(join(root, "secret.txt"), "host file");
	const [layer] = store.ingestTree(t, { move: false });
	const t2 = join(root, "tree2");
	mkdirSync(t2);
	writeFileSync(join(t2, "b.txt"), "B");
	const [layer2] = store.ingestTree(t2, { move: false });
	const r = await sh(
		[
			"cat /in/ab/neg.tif",
			"echo x > /in/ab/neg.tif 2>/dev/null && echo WROTE-IN",
			"cat /in/trees/one/sub/a.txt /in/trees/one/rel",
			"cat /in/trees/one/abs 2>/dev/null || echo ABS-DANGLING",
			"touch /in/trees/one/new 2>/dev/null && echo WROTE-TREE",
			"cat /in/trees/two/sub/a.txt /in/trees/two/b.txt",
			"echo out > /w/result.txt",
			`ls ${HOME} 2>/dev/null; ls ${root} 2>/dev/null && echo SAW-HOST`,
			"echo HOME=$HOME",
		].join("; "),
		plan(),
		{
			inputs: [{ at: "/in/ab/neg.tif", file: store.blobPath(blob) }],
			trees: [
				{ at: "/in/trees/one", lowers: [store.layerDir(layer!)] },
				{ at: "/in/trees/two", lowers: [store.layerDir(layer!), store.layerDir(layer2!)] },
			],
		},
		root,
	);
	assert.equal(r.exit, 0, r.stderr);
	assert.equal(r.stdout, "frame data" + "AA" + "ABS-DANGLING\n" + "AB" + "HOME=/w\n");
	assert.equal(readFileSync(join(r.w, "result.txt"), "utf8"), "out\n");
});

test("no network unless declared: only loopback; host network with network: host", { skip, timeout: 30_000 }, async () => {
	const interfaces = "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '";
	const none = await sh(interfaces, plan());
	assert.equal(none.stdout.trim(), "lo");
	const host = await sh(interfaces, plan({ network: "host" }));
	assert.ok(host.stdout.trim().split("\n").some((i) => i !== "lo"), host.stdout);
});

test("a bind volume is read-only; a named volume is writable for a command and read-only for an agent", { skip, timeout: 30_000 }, async () => {
	const dir = tmp();
	mkdirSync(join(dir, "scripts"));
	writeFileSync(join(dir, "scripts", "s.py"), "print(1)");
	const volumes = resolveVolumes(["./scripts:/scripts:ro", "env-cache:/opt/venv"], dir);
	const script = "cat /scripts/s.py; touch /scripts/x 2>/dev/null && echo WROTE-BIND; echo v > /opt/venv/f 2>/dev/null && echo WROTE-NAMED";
	const command = await sh(script, plan({ volumes }));
	assert.equal(command.stdout, "print(1)WROTE-NAMED\n");
	const agent = await sh(script, plan({ volumes }), { agent: true });
	assert.equal(agent.stdout, "print(1)");
	assert.ok(!existsSync(join(dir, "scripts", "x")));
});

test("a required program runs by its real path, keeps argv[0], and finds its prefix's share; its siblings are not there", { skip, timeout: 30_000 }, async () => {
	const prefix = join(tmp(), "toolchain");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	mkdirSync(join(prefix, "share", "tool"), { recursive: true });
	writeFileSync(join(prefix, "share", "tool", "data"), "shared data");
	writeFileSync(join(prefix, "bin", "tool"), '#!/bin/sh\ncat "$(dirname "$0")/../share/tool/data"; ls "$(dirname "$0")"\n');
	writeFileSync(join(prefix, "bin", "other"), "#!/bin/sh\necho other\n");
	chmodSync(join(prefix, "bin", "tool"), 0o755);
	chmodSync(join(prefix, "bin", "other"), 0o755);
	const programs = { ...resolvePrograms(["sh"]), ...resolvePrograms(["tool"], join(prefix, "bin")) };
	const w = join(tmp(), "w");
	mkdirSync(w);
	const r = await runSpawn(sandboxed(plan({ programs }), ["tool"], { work: { kind: "dir", dir: w }, inputs: [], trees: [] }), "");
	assert.equal(r.exit, 0, r.stderr);
	assert.equal(r.stdout, "shared datatool\n");
	const other = await runSpawn(sandboxed(plan({ programs }), ["sh", "-c", "other || echo NO-OTHER"], { work: { kind: "dir", dir: w }, inputs: [], trees: [] }), "");
	assert.match(other.stdout, /NO-OTHER/);
});

test("a killed process reports its signal; stdin carries the input", { skip, timeout: 30_000 }, async () => {
	// The OOM killer's case: the program's process dies by SIGKILL.
	const r = await sh('sh -c "kill -9 \\$\\$"; exit $?', plan());
	assert.equal(r.signal, "SIGKILL");
	const w = join(tmp(), "w");
	mkdirSync(w);
	const echo = await runSpawn(sandboxed(plan(), ["sh", "-c", "cat"], { work: { kind: "dir", dir: w }, inputs: [], trees: [] }), '{"frame":"2835"}');
	assert.equal(echo.stdout, '{"frame":"2835"}');
});

test("a required script whose #! interpreter the sandbox would not have is refused, naming the interpreter", { skip, timeout: 30_000 }, async () => {
	const d = tmp();
	mkdirSync(join(d, "interp/bin"), { recursive: true });
	mkdirSync(join(d, "tool/bin"), { recursive: true });
	// The interpreter: a copy of sh outside the host base.
	writeFileSync(join(d, "interp/bin/myinterp"), readFileSync("/bin/sh"));
	chmodSync(join(d, "interp/bin/myinterp"), 0o755);
	writeFileSync(join(d, "tool/bin/mytool"), `#!${join(d, "interp/bin/myinterp")}\necho ran\n`);
	chmodSync(join(d, "tool/bin/mytool"), 0o755);
	const path = `${join(d, "tool/bin")}:${join(d, "interp/bin")}:/usr/bin`;
	assert.throws(() => resolvePrograms(["mytool"], path), /mytool \(.*\) runs under .*\/interp\/bin\/myinterp, from its #! line, which the sandbox would not have; add the interpreter/);
	writeFileSync(join(d, "tool/bin/envtool"), "#!/usr/bin/env myinterp\necho ran\n");
	chmodSync(join(d, "tool/bin/envtool"), 0o755);
	assert.throws(() => resolvePrograms(["envtool"], path), /runs under myinterp \(through \/usr\/bin\/env\)/);
	// Required, the interpreter is there and the script runs.
	const programs = resolvePrograms(["mytool", "myinterp"], path);
	const r = await runSpawn(sandboxed(plan({ programs }), ["mytool"], { work: { kind: "dir", dir: tmp() }, inputs: [], trees: [] }), "");
	assert.deepEqual([r.exit, r.stdout, r.setup], [0, "ran\n", null]);
});

test("a sandbox that cannot start its command is told apart from the command's own exit", { skip, timeout: 30_000 }, async () => {
	const view: CallView = { work: { kind: "dir", dir: tmp() }, inputs: [], trees: [] };
	const failed = await runSpawn(sandboxed(plan(), ["/no/such/program"], view), "");
	assert.equal(failed.exit, 1);
	assert.match(failed.setup ?? "", /^bwrap: execvp \/no\/such\/program/);
	const own = await runSpawn(sandboxed(plan(), ["sh", "-c", "echo oops >&2; exit 1"], view), "");
	assert.deepEqual([own.exit, own.setup], [1, null]);
});
