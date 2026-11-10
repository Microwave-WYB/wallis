// RED TEAM: the bwrap sandbox an agent or command runs in. Real bwrap where
// available; skipped with a reason when it is missing. The claims:
//   - agents and commands never have network;
//   - /proc shows only the sandbox, /dev is minimal (no block devices);
//   - the workflow dir and $HOME are not visible;
//   - a named volume is writable for a command but read-only for an agent.
// Each test runs a scripted shell in the sandbox and asserts the outcome.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bwrapAvailable, Sandboxes } from "../../src/host/index.ts";
import { resolveVolumes } from "../../src/host/volumes.ts";
import { parseVolume } from "../../src/sdk/volumes.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "escape-cache-"));
const skip = !bwrapAvailable() && "bubblewrap cannot create a sandbox here";

const made: string[] = [];
function tmp(prefix = "escape-"): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	made.push(d);
	return d;
}
after(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

const SH = realpathSync("/bin/sh");

function boxes(volumes: string[] = [], workflowDir = tmp("wd-")) {
	const decl = {
		requires: [{ name: "sh", check: ["sh", "-c", "true"] }],
		setup: [],
		volumes: volumes.map(parseVolume),
		devices: [],
		network: "none" as const,
		environment: {},
		image: null,
	};
	const resolved = resolveVolumes("w", workflowDir, { box: decl }, { root: workflowDir });
	return new Sandboxes({ decls: { box: decl }, bins: { sh: SH }, volumes: resolved, bindDigests: {} });
}

/** Run `script` in sandbox `box`; `agent:true` applies the agent rules (named volumes read-only). */
function run(b: Sandboxes, script: string, agent = false): { exit: number; out: string } {
	const sp = b.spawn("box", ["sh", "-c", script], { scratch: tmp("w-"), inputs: null }, agent ? { agent: true } : {});
	const r = spawnSync(sp.command, sp.args, { env: sp.env, cwd: sp.cwd, encoding: "utf8", timeout: 30_000 });
	return { exit: r.status ?? 128, out: `${r.stdout}${r.stderr}`.trim() };
}

test("an agent/command sandbox has no network: no route, no TCP, no DNS", { skip }, () => {
	const b = boxes();
	// Only loopback exists.
	const ifaces = run(b, "ip -o addr show 2>/dev/null | awk '{print $2}' | sort -u | tr '\\n' ','");
	assert.ok(/^lo,?$/.test(ifaces.out) || ifaces.out === "", `only loopback, got: ${ifaces.out}`);
	// A TCP connect to a public address fails: the network is unreachable.
	const tcp = run(b, "timeout 5 sh -c 'echo > /dev/tcp/1.1.1.1/53' 2>&1 && echo OPEN || echo BLOCKED");
	assert.match(tcp.out, /BLOCKED|unreachable/i);
	assert.doesNotMatch(tcp.out, /\bOPEN\b/);
});

test("/proc shows only the sandbox's own processes, not the host's", { skip }, () => {
	const b = boxes();
	// A fresh pid namespace: a handful of processes, not the host's hundreds.
	const n = run(b, "ls /proc | grep -E '^[0-9]+$' | wc -l");
	assert.ok(Number(n.out) < 20, `private proc, got ${n.out} pids`);
	// The host's init (a long-running system process) is not visible by a high pid.
	const host = run(b, "cat /proc/1000/cmdline 2>/dev/null | tr '\\0' ' '; echo done");
	assert.equal(host.out, "done", "no host pid 1000 inside");
});

test("/dev is minimal: the usual null/zero/random, but no host block devices", { skip }, () => {
	const b = boxes();
	assert.equal(run(b, "test -c /dev/null && test -c /dev/zero && echo ok").out, "ok");
	// No disks, no loop devices, no device-mapper: a sandbox cannot touch host storage.
	const disks = run(b, "ls /dev | grep -E '^(sd|nvme|vd|loop|dm-|mapper)' | head; echo END");
	assert.equal(disks.out, "END", `no block devices, got: ${disks.out}`);
});

test("the workflow dir and $HOME are not mounted anywhere in the sandbox", { skip }, () => {
	const wd = tmp("MY-PROJECT-");
	writeFileSync(join(wd, "prompts.txt"), "judge secrets");
	const b = boxes([], wd);
	// $HOME inside is /w, not the real home; /home is absent.
	assert.equal(run(b, "echo $HOME").out, "/w");
	assert.match(run(b, "ls /home 2>&1 | head -1; echo END").out, /END/);
	// The workflow dir's own path is not reachable.
	assert.match(run(b, `ls ${wd} 2>&1 | head -1`).out, /No such file|cannot access|Permission denied/);
});

test("a named volume is writable for a command but read-only for an agent", { skip }, () => {
	const b = boxes(["cache:/cache"]);
	// Command: writable cache.
	const asCmd = run(b, "echo hi > /cache/by-command && cat /cache/by-command");
	assert.equal(asCmd.exit, 0);
	assert.equal(asCmd.out, "hi");
	// Agent: the same target is read-only (an agent's writes would reach later runs outside every cache key).
	const asAgent = run(b, "echo evil > /cache/by-agent 2>&1 && echo WROTE || echo READONLY", true);
	assert.match(asAgent.out, /READONLY|Read-only/);
	// The command's file is still there and uncorrupted by the agent.
	assert.equal(run(b, "cat /cache/by-command").out, "hi");
});

test("a bind volume is read-only inside the sandbox; the host source is never written", { skip }, () => {
	const wd = tmp("wd-");
	const src = join(wd, "scripts");
	mkdirSync(src);
	writeFileSync(join(src, "hi.txt"), "hi");
	const b = boxes(["./scripts:/scripts:ro"], wd);
	assert.equal(run(b, "cat /scripts/hi.txt").out, "hi");
	assert.match(run(b, "echo x > /scripts/new 2>&1 && echo WROTE || echo RO").out, /RO|Read-only/);
	assert.equal(readdirSync(src).sort().join(","), "hi.txt", "no new file in the host source");
});

// --- ESCAPE-01, closed: bwrap runs the program as PID 1 (--as-pid-1) ----------------

test(
	"a sandboxed agent/command cannot read the host-side bwrap argv via /proc/1/cmdline",
	{ skip },
	() => {
		const wd = tmp("SECRET-PROJECT-");
		const src = join(wd, "trainer");
		mkdirSync(src);
		writeFileSync(join(src, "t"), "x");
		const b = boxes(["./trainer:/trainer:ro"], wd);
		const r = run(b, "tr '\\0' ' ' < /proc/1/cmdline 2>/dev/null; echo", true);
		// The claim (confine.ts): "and nothing else: not the workflow dir, not $HOME."
		// The sandbox must NOT be able to learn the host source path of its bind volume.
		assert.ok(!r.out.includes(src), `/proc/1/cmdline leaked the host bind source path: ${src}`);
	},
);
