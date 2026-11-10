// Sandbox volumes: the parse of compose-style volume strings, the preflight
// of what the bwrap backend can honour (typed refusals), and named volumes
// as writable caches shared across runs and left out of the cache key.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxDigest } from "../src/host/confine.ts";
import { bwrapAvailable, Sandboxes } from "../src/host/index.ts";
import { bindDigest, checkDevices, namedVolumesDir, resolveVolumes, VolumeError } from "../src/host/volumes.ts";
import { parseVolume, type Volume } from "../src/sdk/volumes.ts";
import { tmp } from "./util.ts";

process.env.XDG_CACHE_HOME = tmp("wallis-cache-");
const skip = !bwrapAvailable() && "bubblewrap cannot create a sandbox here";

test("a volume string parses to a bind, a named volume, or an invalid one with its reason", () => {
	assert.deepEqual(parseVolume("./scripts:/scripts:ro"), { kind: "bind", host: "./scripts", target: "/scripts" });
	assert.deepEqual(parseVolume("~/data:/data:ro"), { kind: "bind", host: "~/data", target: "/data" });
	assert.deepEqual(parseVolume("dt-cache:/root/.cache/darktable"), { kind: "named", name: "dt-cache", target: "/root/.cache/darktable" });
	const reason = (text: string) => {
		const v = parseVolume(text);
		return v.kind === "invalid" ? v.reason : null;
	};
	assert.match(reason("./scripts:/scripts")!, /needs its mode/);
	assert.match(reason("./scripts:/scripts:rw")!, /only :ro exists/);
	assert.match(reason("/etc:/etc2:ro")!, /relative/);
	assert.match(reason("./scripts:scripts:ro")!, /absolute/);
	assert.match(reason("a:b:c:d")!, /<host path>:<target>:ro or <name>:<target>/);
});

function resolveRefusal(volumes: readonly Volume[], callTime?: Record<string, string>) {
	const dir = tmp();
	mkdirSync(join(dir, "scripts"));
	try {
		resolveVolumes("w", dir, { box: { volumes } }, { root: dir, ...(callTime ? { callTime } : {}) });
		return null;
	} catch (error) {
		if (error instanceof VolumeError) return error.refusal;
		throw error;
	}
}

test("targets that overlap a dir the backend owns, or each other, are typed refusals", () => {
	const bind = (target: string): Volume => ({ kind: "bind", host: "./scripts", target });
	for (const target of ["/usr", "/usr/local/share", "/lib64", "/proc", "/dev/dri", "/in", "/w/x", "/tmp", "/run/wallis/env", "/run", "/"]) {
		const r = resolveRefusal([bind(target)]);
		assert.equal(r?.type, "invalid_volume", target);
		assert.match((r as { reason: string }).reason, /owns/, target);
	}
	assert.deepEqual(resolveRefusal([bind("/scripts"), { kind: "named", name: "c", target: "/scripts/cache" }]), {
		type: "invalid_volume",
		sandbox: "box",
		volume: "c:/scripts/cache",
		reason: "the target overlaps the volume at /scripts",
	});
	assert.equal(resolveRefusal([bind("/a/../usr")])?.type, "invalid_volume");
	assert.equal(resolveRefusal([bind("/scripts/")])?.type, "invalid_volume");
	// One that slipped past the types is refused with the parse's reason.
	assert.deepEqual(resolveRefusal([parseVolume("./scripts:/scripts:rw")]), {
		type: "invalid_volume",
		sandbox: "box",
		volume: "./scripts:/scripts:rw",
		reason: "mode rw: only :ro exists (a volume is never writable; write user dirs with wallis export)",
	});
	assert.equal(resolveRefusal([bind("/scripts"), bind("/opt/x")]), null);
});

test("a bind's host dir must exist; a caller-given dir is keyed by target and must name a bind", () => {
	const missing = resolveRefusal([{ kind: "bind", host: "./nothing", target: "/n" }]);
	assert.equal(missing?.type, "volume_missing");
	assert.equal(resolveRefusal([{ kind: "bind", host: "./nothing", target: "/n" }], { "/n": tmp() }), null);
	assert.deepEqual(resolveRefusal([{ kind: "bind", host: "./scripts", target: "/s" }], { "/other": tmp() }), { type: "unknown_volume", target: "/other" });
	// A named volume's target is not the caller's to remap.
	assert.deepEqual(resolveRefusal([{ kind: "named", name: "c", target: "/c" }], { "/c": tmp() }), { type: "unknown_volume", target: "/c" });
});

test("a declared device this host lacks is a typed refusal", () => {
	assert.doesNotThrow(() => checkDevices({ box: { devices: ["/dev/null"] } }));
	assert.throws(
		() => checkDevices({ box: { devices: ["/dev/wallis-none"] } }),
		(e: unknown) => e instanceof VolumeError && JSON.stringify(e.refusal) === JSON.stringify({ type: "device_missing", sandbox: "box", device: "/dev/wallis-none" }),
	);
	assert.throws(() => checkDevices({ box: { devices: ["/etc/passwd"] } }), VolumeError);
	// Only character devices (or dirs of them) under /dev: anything else would be a writable host bind.
	const refused = (device: string) => {
		try {
			checkDevices({ box: { devices: [device] } });
			return null;
		} catch (e) {
			return e instanceof VolumeError ? e.refusal.type : String(e);
		}
	};
	for (const device of ["/dev/../tmp", "/dev/./null", "/dev//null", "/dev/shm", "/dev/pts", "/dev/mqueue", "/dev/fd", "/dev/stdin", "/dev/"]) assert.equal(refused(device), "invalid_device", device);
	assert.equal(refused("/dev/null"), null);
	if (existsSync("/dev/dri")) assert.equal(refused("/dev/dri"), null, "a dir of devices, its by-path links included");
});

test("a bind's digest follows its content; a named volume is not part of the sandbox digest", () => {
	const dir = tmp();
	writeFileSync(join(dir, "a.py"), "print(1)");
	const before = bindDigest(dir);
	assert.match(before, /^bind:sha256:[0-9a-f]{64}$/);
	writeFileSync(join(dir, "a.py"), "print(2)");
	assert.notEqual(bindDigest(dir), before);
	const decl = { requires: [], setup: [], volumes: [parseVolume("./s:/s:ro"), parseVolume("cache:/cache")], devices: [], network: "none", environment: {}, image: null } as const;
	assert.equal(sandboxDigest(decl, {}, { "/s": before }), sandboxDigest(decl, {}, { "/s": before }));
	assert.notEqual(sandboxDigest(decl, {}, { "/s": before }), sandboxDigest(decl, {}, { "/s": bindDigest(dir) }));
});

test("in the sandbox: a bind is read-only at its target, a named volume is writable and shared, devices and environment as declared", { skip }, () => {
	const workflowDir = tmp();
	mkdirSync(join(workflowDir, "scripts"));
	writeFileSync(join(workflowDir, "scripts", "hi.txt"), "hi");
	const decl = {
		requires: [{ name: "sh", check: ["sh", "-c", "true"] }],
		setup: [],
		volumes: [parseVolume("./scripts:/scripts:ro"), parseVolume("cache:/var/cache/thing")],
		devices: ["/dev/null"],
		network: "none",
		environment: { THING: "yes" },
		image: null,
	} as const;
	const volumes = resolveVolumes("w", workflowDir, { box: decl }, { root: workflowDir });
	const boxes = new Sandboxes({ decls: { box: decl }, bins: { sh: realpathSync("/bin/sh") }, volumes, bindDigests: {} });
	const run = (script: string) => {
		const sp = boxes.spawn("box", ["sh", "-c", script], { scratch: tmp(), inputs: null });
		const r = spawnSync(sp.command, sp.args, { env: sp.env, cwd: sp.cwd, encoding: "utf8" });
		return `${r.stdout}${r.stderr}`.trim();
	};
	assert.equal(run("cat /scripts/hi.txt"), "hi");
	assert.match(run("echo x > /scripts/new 2>&1 || echo refused"), /refused|Read-only/);
	assert.equal(run("echo kept > /var/cache/thing/k && echo $THING"), "yes");
	// Shared across runs: the next sandbox (another call, another run) sees it, as does the host.
	assert.equal(run("cat /var/cache/thing/k"), "kept");
	assert.equal(readFileSync(join(namedVolumesDir(), "cache", "k"), "utf8"), "kept\n");
	assert.equal(run("test -c /dev/null && echo dev"), "dev");
});

test("agents and commands never get network: a host-network sandbox is for tool sources only", async () => {
	const { declarations } = await import("../src/sdk/runtime.ts");
	const { command, defineAgent, defineModels, defineSandbox, Type, workflow } = await import("../src/sdk/index.ts");
	const models = defineModels({ default: "fake/default" });
	const net = defineSandbox({}, { name: "net", requires: ["sh"], network: "host" });
	const fetch = command({ name: "fetch", sandbox: net, input: Type.Null(), output: Type.Null(), run: ["sh", "-c", "true"] });
	const reader = defineAgent({ models }, { name: "reader", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), workspace: { access: "read", sandbox: net } });
	const base = { name: "n", models, input: Type.Null(), output: Type.Null(), run: async () => null };
	assert.throws(() => declarations(workflow({ ...base, agents: [], commands: [fetch] })), /command fetch: commands never get network/);
	assert.throws(() => declarations(workflow({ ...base, agents: [reader] })), /agent reader: agents never get network/);
});

test("describe lists each sandbox's volumes, devices and network", async () => {
	const { describeWorkflow } = await import("../src/host/describe.ts");
	const workflow = join(import.meta.dirname, "fixtures/artifacts/workflow.ts");
	const d = (await describeWorkflow(workflow, tmp())) as { sandboxes: Record<string, unknown> };
	assert.deepEqual(d.sandboxes.trainer, {
		volumes: [
			{ bind: "./scripts", target: "/scripts", mode: "ro" },
			{ bind: "./corpus", target: "/corpus", mode: "ro" },
		],
		devices: [],
		network: "none",
	});
});

test("a snapshot of a bind: a copy named by its digest, the same digest as its host dir; symlinks count", async () => {
	const { snapshotBind, bindSnapshotDir } = await import("../src/host/volumes.ts");
	const { symlinkSync } = await import("node:fs");
	const dir = tmp();
	writeFileSync(join(dir, "a.py"), "print(1)");
	symlinkSync("a.py", join(dir, "link"));
	const runDir = tmp();
	const digest = snapshotBind(runDir, dir);
	assert.equal(digest, bindDigest(dir));
	assert.equal(readFileSync(join(bindSnapshotDir(runDir, digest), "a.py"), "utf8"), "print(1)");
	// Taken again unchanged: the same snapshot.
	assert.equal(snapshotBind(runDir, dir), digest);
	const { unlinkSync } = await import("node:fs");
	unlinkSync(join(dir, "link"));
	symlinkSync("elsewhere", join(dir, "link"));
	assert.notEqual(bindDigest(dir), digest, "a symlink's target is part of the digest");
});

test("binds are snapshotted when a run starts: an edit while it waits never reaches it; a fork takes a new snapshot", { skip }, async () => {
	const { appendInbox, EventLog, FakeExecutor, forkRun, ProcessCommands, readMeta, runPaths, runWorkflow } = await import("../src/host/index.ts");
	const { readBlob } = await import("../src/host/artifacts.ts");
	const root = tmp("wallis-snap-");
	const wf = join(root, "wf");
	mkdirSync(join(wf, "data"), { recursive: true });
	writeFileSync(join(wf, "data", "x"), "old");
	writeFileSync(
		join(wf, "workflow.ts"),
		`import { command, defineModels, defineSandbox, orchestrator, Type, workflow } from "wallis";
const box = defineSandbox({}, { name: "box", requires: ["sh"], volumes: ["./data:/data:ro"] });
const read = command({ name: "read", sandbox: box, input: Type.Object({ n: Type.Number() }), output: Type.Object({ v: Type.String() }), run: ["sh", "-c", 'printf "{\\\\"v\\\\":\\\\"%s\\\\"}" "$(cat /data/x)"'] });
const go = orchestrator({ name: "go", input: Type.Null(), output: Type.Boolean() });
export default workflow({ name: "snap", models: defineModels({ default: "fake/default" }), agents: [], commands: [read], orchestrators: [go], input: Type.Null(), output: Type.Any(),
	run: async (ctx) => { const a = await ctx.call(read, { n: 1 }); await ctx.call(go, null); const b = await ctx.call(read, { n: 2 }); return { a: a.v, b: b.v }; } });\n`,
	);
	const dir = join(root, ".wallis", "runs", "r1");
	const opts = { workflow: join(wf, "workflow.ts"), root, executor: new FakeExecutor({}), commands: new ProcessCommands(), confine: "require" as const, bins: { sh: realpathSync("/bin/sh") }, local: {}, inboxPollMs: null };
	const first = await runWorkflow({ ...opts, dir, input: null });
	assert.equal(first.run.nodes.at(-1)?.type, "orchestrator_pending");
	const meta = readMeta(runPaths(dir))!;
	assert.deepEqual(Object.keys(meta.binds!), [join(wf, "data")]);
	// The workflow bundle is in the run's store under the pinned digest.
	const started = new EventLog(join(dir, "log.jsonl")).read()[0] as { pin: { workflow_digest: string } };
	assert.ok(readBlob(dir, started.pin.workflow_digest)?.includes("snap"));
	writeFileSync(join(wf, "data", "x"), "new");
	appendInbox(runPaths(dir), { id: "a1", type: "submit", node: "#1", value: true, by: "human" });
	const done = await runWorkflow({ ...opts, dir });
	assert.deepEqual(done.outcome, { type: "done", value: { a: "old", b: "old" } }, "the run sees its snapshot");
	// A fork snapshots anew: the calls that bind it miss and see the edit.
	const fork = forkRun(dir, join(root, ".wallis", "runs", "r2"));
	appendInbox(runPaths(fork.dir), { id: "a2", type: "submit", node: "#1", value: true, by: "human" });
	const forked = await runWorkflow({ ...opts, dir: fork.dir });
	assert.deepEqual(forked.outcome, { type: "done", value: { a: "new", b: "new" } });
});

test("environment never reaches the host side: bwrap by absolute path, only secrets in its environment, the rest set inside", async () => {
	const { checkEnvironments } = await import("../src/host/volumes.ts");
	const { chmodSync } = await import("node:fs");
	const decl = (environment: Record<string, string>, secrets: string[] = []) => ({
		sandboxes: { box: { environment } },
		toolsets: { "./t.ts": { sandbox: "box", secrets } },
		mcp: { mcpServers: { srv: { command: "x", env: { TOKEN: "${TOKEN}" } } } },
		mcpServers: { srv: { sandbox: "box" } },
	});
	const refusal = (d: ReturnType<typeof decl>) => {
		try {
			checkEnvironments(d);
			return null;
		} catch (e) {
			return e instanceof VolumeError ? e.refusal : String(e);
		}
	};
	// The reviewer's repro: a PATH that put a fake bwrap first on the host.
	assert.deepEqual(refusal(decl({ PATH: "/tmp/fake:/usr/bin" })), { type: "invalid_environment", sandbox: "box", key: "PATH", reason: "set by wallis" });
	for (const key of ["HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "WALLIS_ENV", "A-B"]) assert.equal((refusal(decl({ [key]: "x" })) as { type: string }).type, "invalid_environment", key);
	for (const key of ["LD_PRELOAD", "GCONV_PATH", "SYSTEMD_LOG_LEVEL", "PATH"]) assert.equal((refusal(decl({}, [key])) as { type: string }).type, "invalid_environment", key);
	assert.equal(refusal(decl({ DARKTABLE_FLAGS: "x" }, ["S2_API_KEY"])), null);
	// The spawn itself: bwrap by its absolute path; its environment is the secrets alone; the rest is --setenv.
	const fake = tmp();
	writeFileSync(join(fake, "bwrap"), "#!/bin/sh\ntouch /tmp/wallis-fake-bwrap-ran\n");
	chmodSync(join(fake, "bwrap"), 0o755);
	const decls = { box: { requires: [], setup: [], volumes: [], devices: [], network: "none", environment: { THING: "yes" }, image: null } as const };
	const boxes = new Sandboxes({ decls, bins: {}, volumes: {}, bindDigests: {} });
	const sp = boxes.spawn("box", ["/bin/true"], { scratch: tmp(), inputs: null }, { secrets: { TOKEN: "s3cret" }, env: { WALLIS_COMPUTE_MINUTES: "5" } });
	assert.ok(sp.command.startsWith("/") && sp.command.endsWith("bwrap") && !sp.command.startsWith(fake));
	assert.deepEqual(sp.env, { TOKEN: "s3cret" });
	assert.ok(!sp.args.includes("s3cret"), "a secret never appears on the command line");
	const setenv = (k: string) => sp.args[sp.args.indexOf(k) + 1];
	assert.equal(sp.args[sp.args.indexOf("THING") - 1], "--setenv");
	assert.equal(setenv("THING"), "yes");
	assert.equal(setenv("WALLIS_COMPUTE_MINUTES"), "5");
	// And a key that slips past preflight is refused by the spawn itself.
	const bad = new Sandboxes({ decls: { box: { ...decls.box, environment: { LD_PRELOAD: "/tmp/x.so" } } }, bins: {}, volumes: {}, bindDigests: {} });
	assert.throws(() => bad.spawn("box", ["/bin/true"], { scratch: tmp(), inputs: null }), /invalid_environment/);
});

test("inside the sandbox the declared environment and the secrets are set; the host's are not", { skip }, () => {
	const decls = { box: { requires: [{ name: "sh", check: ["sh", "-c", "true"] }], setup: [], volumes: [], devices: [], network: "none", environment: { THING: "yes" }, image: null } as const };
	const boxes = new Sandboxes({ decls, bins: { sh: realpathSync("/bin/sh") }, volumes: {}, bindDigests: {} });
	const sp = boxes.spawn("box", ["sh", "-c", 'echo "$THING $TOKEN $HOME ${USER:-none}"'], { scratch: tmp(), inputs: null }, { secrets: { TOKEN: "s3cret" } });
	const r = spawnSync(sp.command, sp.args, { env: sp.env, cwd: sp.cwd, encoding: "utf8" });
	assert.equal(r.stdout.trim(), "yes s3cret /w none");
});

test("a required program's binds: itself and its prefix's lib/share/libexec, never the prefix, the home dir, /opt or the project", async () => {
	const { programBinds } = await import("../src/host/confine.ts");
	const home = tmp("wallis-home-");
	const make = (path: string) => (mkdirSync(path, { recursive: true }), path);
	// The reviewer's table: each was a bind of a whole dir.
	assert.deepEqual(programBinds(join(home, "mytool"), { home }), [join(home, "mytool")], "~/mytool: not all of ~");
	make(join(home, ".local", "share"));
	assert.deepEqual(programBinds(join(home, ".local", "bin", "x"), { home }), [join(home, ".local", "bin", "x")], "~/.local/bin/x: not ~/.local/share");
	make(join(home, ".cargo", "lib"));
	assert.deepEqual(programBinds(join(home, ".cargo", "bin", "x"), { home }), [join(home, ".cargo", "bin", "x")]);
	assert.deepEqual(programBinds("/opt/bin/x", { home }), ["/opt/bin/x"], "/opt/bin/x: not all of /opt");
	const project = make(join(home, "proj"));
	make(join(project, "share"));
	assert.deepEqual(programBinds(join(project, "bin", "tool"), { home, root: project }), [join(project, "bin", "tool")], "<project>/bin/tool: not the project");
	assert.deepEqual(programBinds("/usr/bin/darktable", { home }), [], "the base is there already");
	// A normal prefix: the program, and the parts of the prefix that exist.
	const prefix = join(home, "apps", "dt");
	make(join(prefix, "share", "darktable"));
	make(join(prefix, "lib"));
	assert.deepEqual(programBinds(join(prefix, "bin", "darktable"), { home }), [join(prefix, "bin", "darktable"), join(prefix, "lib"), join(prefix, "share")]);
});

test("in the sandbox a required program finds its share dir; its siblings and the rest of its prefix are not there", { skip }, async () => {
	const { chmodSync } = await import("node:fs");
	const prefix = tmp("wallis-prefix-");
	mkdirSync(join(prefix, "bin"));
	mkdirSync(join(prefix, "share", "tool"), { recursive: true });
	writeFileSync(join(prefix, "share", "tool", "data"), "found");
	writeFileSync(join(prefix, "secret"), "secret");
	writeFileSync(join(prefix, "bin", "tool"), `#!/bin/sh\ncat "$(dirname "$(readlink -f "$0")")/../share/tool/data"; echo; cat ${prefix}/secret 2>/dev/null || echo no-secret; command -v other || echo no-other; echo "$PATH"\n`);
	writeFileSync(join(prefix, "bin", "other"), "#!/bin/sh\necho other\n");
	chmodSync(join(prefix, "bin", "tool"), 0o755);
	chmodSync(join(prefix, "bin", "other"), 0o755);
	const decls = { box: { requires: [{ name: "tool", check: ["tool"] }], setup: [], volumes: [], devices: [], network: "none", environment: {}, image: null } as const };
	const boxes = new Sandboxes({ decls, bins: { tool: join(prefix, "bin", "tool") }, volumes: {}, bindDigests: {}, cacheDir: join(tmp(), "envs") });
	const sp = boxes.spawn("box", ["tool"], { scratch: tmp(), inputs: null });
	const r = spawnSync(sp.command, sp.args, { env: sp.env, cwd: sp.cwd, encoding: "utf8" });
	assert.deepEqual(r.stdout.trim().split("\n"), ["found", "no-secret", "no-other", "/run/wallis/bin:/usr/local/bin:/usr/bin:/bin"], r.stderr);
	// The tool is on PATH by its name.
	const byName = boxes.spawn("box", ["/bin/sh", "-c", "command -v tool"], { scratch: tmp(), inputs: null });
	assert.equal(spawnSync(byName.command, byName.args, { env: byName.env, cwd: byName.cwd, encoding: "utf8" }).stdout.trim(), "/run/wallis/bin/tool");
});

test("darktable still runs in a sandbox that requires it", { skip: (!existsSync("/usr/bin/darktable-cli") && "darktable is not installed") || skip }, () => {
	const decls = { box: { requires: [{ name: "darktable-cli", check: ["darktable-cli", "--version"] }], setup: [], volumes: [], devices: [], network: "none", environment: {}, image: null } as const };
	const boxes = new Sandboxes({ decls, bins: { "darktable-cli": "/usr/bin/darktable-cli" }, volumes: {}, bindDigests: {}, cacheDir: join(tmp(), "envs") });
	// Its check runs inside the sandbox (prepare throws requires_broken if it cannot start).
	assert.match(boxes.prepare()["darktable-cli"]!, /darktable/i);
});
