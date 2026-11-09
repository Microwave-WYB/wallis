// Sandbox volumes: the parse of compose-style volume strings, the preflight
// of what the bwrap backend can honour (typed refusals), and named volumes
// as writable caches shared across runs and left out of the cache key.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
