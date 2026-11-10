// RED TEAM: secrets (a toolset's `secrets`, an MCP server's env) must never
// appear in argv, and must never reach a sandbox that was not given them.
// They ride only in the environment of the host-side bwrap, so they stay off
// the command line. We check the spawn the host builds, and — under real
// bwrap — that an AGENT sandbox (which is given no secrets) cannot read any
// secret, including via /proc/1/environ.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bwrapAvailable, Sandboxes } from "../../src/host/index.ts";

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

const SECRET = "SUPERSECRET-sk-abc123";

function boxes(environment: Record<string, string> = {}) {
	const decl = { requires: [{ name: "sh", check: ["sh", "-c", "true"] }], setup: [], volumes: [], devices: [], network: "none" as const, environment, image: null };
	return new Sandboxes({ decls: { box: decl }, bins: { sh: realpathSync("/bin/sh") }, volumes: {}, bindDigests: {} });
}

test("a secret never appears on the bwrap command line; it rides only in the spawn's environment", () => {
	const sp = boxes().spawn("box", ["sh", "-c", "true"], { scratch: tmp("w-"), inputs: null }, { secrets: { API_KEY: SECRET }, network: "host" });
	assert.ok(!sp.args.some((a) => a.includes(SECRET)), "secret must not be an argv token");
	assert.ok(!JSON.stringify(sp.args).includes(SECRET), "secret must not appear anywhere in argv");
	assert.deepEqual(sp.env, { API_KEY: SECRET }, "the host-side env carries only the secret");
});

test("an agent/command spawn is given NO secrets, and does not inherit wallis's own environment", () => {
	// No `secrets` option: the host-side env is empty. wallis's own env (model API keys, etc.) is never passed through.
	const sp = boxes({ THING: "declared" }).spawn("box", ["sh", "-c", "true"], { scratch: tmp("w-"), inputs: null }, { env: { WALLIS_COMPUTE_MINUTES: "5" } });
	assert.deepEqual(sp.env, {}, "no secrets, and no inherited host environment");
	// The declared var is set INSIDE with --setenv, not through the host-side env.
	assert.equal(sp.args[sp.args.indexOf("THING") - 1], "--setenv");
});

test("under real bwrap, an agent sandbox cannot read any secret (its /proc/1/environ holds none)", { skip }, () => {
	// The agent sandbox is spawned with no secrets. Even though bwrap (PID 1) is readable at
	// /proc/1/environ, its environment is empty of secrets for an agent, so nothing leaks.
	const sp = boxes().spawn(
		"box",
		["sh", "-c", "tr '\\0' '\\n' < /proc/1/environ 2>/dev/null | grep -i secret; env | grep -i secret; echo END"],
		{ scratch: tmp("w-"), inputs: null },
		{ agent: true },
	);
	const r = spawnSync(sp.command, sp.args, { env: sp.env, cwd: sp.cwd, encoding: "utf8", timeout: 20_000 });
	const out = `${r.stdout}${r.stderr}`.trim();
	assert.equal(out, "END", `an agent sandbox must expose no secret, got: ${out}`);
});

test("a secret name that would steer the host-side spawn is rejected by the spawn itself", () => {
	// secretEnvProblem is enforced at spawn time too, as a last line of defence.
	assert.throws(
		() => boxes().spawn("box", ["sh", "-c", "true"], { scratch: tmp("w-"), inputs: null }, { secrets: { LD_PRELOAD: "/tmp/x.so" } }),
		/invalid_environment/,
	);
});
