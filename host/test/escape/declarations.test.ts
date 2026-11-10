// RED TEAM: the host parses the workflow VM's declarations (unknown until
// parsed) and re-checks every sandbox rule itself, because workflow code
// controls the VM. We feed hand-built declaration JSON — the shapes a
// malicious VM could emit, which the SDK's own `declarations()` would never
// produce — straight at the host's parser and resolvers, and at the volume,
// device and environment checks. None may slip through.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DeclarationError, parseDeclarations } from "../../src/host/declarations.ts";
import { checkDevices, checkEnvironments, resolveVolumes, VolumeError } from "../../src/host/volumes.ts";

const made: string[] = [];
function tmp(prefix = "escape-"): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	made.push(d);
	return d;
}
after(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A minimal valid declarations object; tests override pieces to attack. */
function base(): Record<string, unknown> {
	const schema = { type: "null" };
	return {
		core: { name: "w", agents: [], commands: [], orchestrators: [], budget: { turns: null, compute_minutes: null } },
		models: { default: "fake/default" },
		pin: { files: [] },
		agents: {},
		commands: {},
		orchestrators: {},
		toolsets: {},
		mcp: null,
		mcpServers: {},
		sandboxes: {},
		input: schema,
		output: schema,
	};
}

const refusal = (fn: () => void): string | null => {
	try {
		fn();
		return null;
	} catch (e) {
		if (e instanceof DeclarationError || e instanceof VolumeError) return JSON.stringify(e.refusal);
		throw e;
	}
};

test("a declaration that is not even the right shape is a typed refusal, never trusted", () => {
	for (const raw of [null, 42, "x", [], { core: {} }]) {
		assert.match(refusal(() => parseDeclarations(raw))!, /invalid_declaration/, JSON.stringify(raw));
	}
});

test("an agent whose sandbox declares network:host is refused by the host parser", () => {
	const d = base();
	d.sandboxes = { net: { requires: [], setup: [], volumes: [], devices: [], network: "host", environment: {}, mem_limit: null, pids_limit: null, image: null } };
	d.agents = {
		spy: { model: "default", prompt: "", input: { type: "null" }, output: { type: "null" }, tools: [], access: 1, skills: [], needs: {}, sandbox: "net", steerable: true, compaction: false, max_turns: 2 },
	};
	assert.match(refusal(() => parseDeclarations(d))!, /invalid_declaration/);
	assert.match((JSON.parse(refusal(() => parseDeclarations(d))!) as { message: string }).message, /agents never get network/);
});

test("a command whose sandbox declares network:host is refused", () => {
	const d = base();
	d.sandboxes = { net: { requires: [], setup: [], volumes: [], devices: [], network: "host", environment: {}, mem_limit: null, pids_limit: null, image: null } };
	d.commands = { fetch: { description: "", input: { type: "null" }, output: { type: "null" }, sandbox: "net", resources: {}, code: ["sh"] } };
	assert.match((JSON.parse(refusal(() => parseDeclarations(d))!) as { message: string }).message, /commands never get network/);
});

test("a node that names an undeclared sandbox is refused", () => {
	const d = base();
	d.commands = { c: { description: "", input: { type: "null" }, output: { type: "null" }, sandbox: "ghost", resources: {}, code: ["sh"] } };
	assert.match((JSON.parse(refusal(() => parseDeclarations(d))!) as { message: string }).message, /sandbox ghost is not declared/);
});

test("prototype-pollution keys in `environment` do not bypass the key check", () => {
	// A VM could emit a declaration whose environment has a `__proto__`/`constructor` key, or LD_*.
	const evil = JSON.parse('{"__proto__":{"polluted":"yes"},"LD_PRELOAD":"/tmp/x.so","PATH":"/tmp/fake"}') as Record<string, string>;
	const decl = {
		sandboxes: { box: { environment: evil } },
		toolsets: {},
		mcp: null,
		mcpServers: {},
	};
	// LD_PRELOAD and PATH are refused outright.
	assert.match(refusal(() => checkEnvironments(decl))!, /invalid_environment/);
	// And no prototype was polluted along the way.
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a secret whose name steers the host-side spawn is refused (toolset and MCP env)", () => {
	for (const key of ["LD_PRELOAD", "GCONV_PATH", "SYSTEMD_LOG_LEVEL", "BWRAP_FOO", "PATH"]) {
		const decl = { sandboxes: { box: { environment: {} } }, toolsets: { "./t.ts": { sandbox: "box", secrets: [key] } }, mcp: null, mcpServers: {} };
		assert.match(refusal(() => checkEnvironments(decl))!, /invalid_environment/, key);
	}
	const mcpDecl = { sandboxes: { box: { environment: {} } }, toolsets: {}, mcp: { mcpServers: { s: { env: { LD_AUDIT: "x" } } } }, mcpServers: { s: { sandbox: "box" } } };
	assert.match(refusal(() => checkEnvironments(mcpDecl))!, /invalid_environment/);
});

test("hand-built bind volumes cannot target a reserved dir, overlap, or escape with `..`", () => {
	const wd = tmp("wd-");
	mkdirSync(join(wd, "scripts"));
	const resolve1 = (target: string) =>
		refusal(() => resolveVolumes("w", wd, { box: { volumes: [{ kind: "bind", host: "./scripts", target }] } }, { root: wd }));
	for (const target of ["/usr", "/etc", "/proc", "/dev", "/w", "/in", "/tmp", "/run/wallis", "/", "/run", "/lib64/x", "/usr/../usr"]) {
		assert.match(resolve1(target)!, /invalid_volume/, target);
	}
	// A bind whose host path is absolute (not relative or ~/) must be refused when it slips past the VM types.
	const abs = refusal(() => resolveVolumes("w", wd, { box: { volumes: [{ kind: "bind", host: "/etc", target: "/x" }] } }, { root: wd }));
	assert.match(abs!, /invalid_volume/);
});

test("a bind that contains or sits inside the project's `.wallis` store is refused", () => {
	const root = tmp("root-");
	mkdirSync(join(root, ".wallis"), { recursive: true });
	mkdirSync(join(root, ".wallis", "runs"), { recursive: true });
	const store = join(root, ".wallis");
	// A bind of the whole project root would snapshot the store into itself.
	const containing = refusal(() =>
		resolveVolumes("w", root, { box: { volumes: [{ kind: "bind", host: "./", target: "/proj" }] } }, { root, stores: [store, join(root, ".wallis", "runs", "r1")] }),
	);
	assert.match(containing!, /invalid_volume/);
	// A bind that IS inside .wallis is refused too.
	const inside = refusal(() =>
		resolveVolumes("w", root, { box: { volumes: [{ kind: "bind", host: "./.wallis/runs", target: "/r" }] } }, { root, stores: [store] }),
	);
	assert.match(inside!, /invalid_volume/);
});

test("only character devices under /dev are bindable; block devices and out-of-dev symlinks are refused", () => {
	const ok = refusal(() => checkDevices({ box: { devices: ["/dev/null"] } }));
	assert.equal(ok, null);
	for (const device of ["/dev/../etc/passwd", "/dev/./null", "/dev//null", "/dev/shm", "/dev/pts", "/dev/mqueue", "/dev/fd", "/etc/passwd", "/dev/sda", "/dev/stdin"]) {
		const r = refusal(() => checkDevices({ box: { devices: [device] } }));
		assert.ok(r !== null && /invalid_device|device_missing/.test(r), `${device} -> ${r}`);
	}
});
