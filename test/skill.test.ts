// The agent skill (skills/wallis): the Agent Skills spec's rules (agentskills.io/specification),
// checked here; its version equals the package's; and, when they are reachable, the reference
// validator (`agentskills validate`, from skills-ref) and Vercel's `skills add . --list`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { here } from "./util.ts";

const root = join(here, "..");
const dir = join(root, "skills", "wallis");
const text = readFileSync(join(dir, "SKILL.md"), "utf8");

/** The frontmatter, a small YAML subset: `key: value` lines and one level of nested maps. */
function frontmatter(): { fields: Record<string, string | Record<string, string>>; body: string } {
	const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	assert.ok(m, "SKILL.md starts with YAML frontmatter");
	const fields: Record<string, string | Record<string, string>> = {};
	let map: Record<string, string> | null = null;
	for (const line of m[1]!.split("\n")) {
		const nested = /^ {2}([a-z_-]+): (.*)$/.exec(line);
		if (nested && map) {
			map[nested[1]!] = nested[2]!.replace(/^"(.*)"$/, "$1");
			continue;
		}
		const top = /^([a-z_-]+):(?: (.*))?$/.exec(line);
		assert.ok(top, `a frontmatter line: ${line}`);
		if (top[2] === undefined || top[2] === "") fields[top[1]!] = map = {};
		else {
			fields[top[1]!] = top[2]!.replace(/^"(.*)"$/, "$1");
			map = null;
		}
	}
	return { fields, body: m[2]! };
}

test("SKILL.md follows the Agent Skills spec", () => {
	const { fields, body } = frontmatter();
	const name = fields.name as string;
	assert.equal(name, "wallis");
	assert.equal(name, "wallis", "name equals the directory name");
	assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, digits and single hyphens");
	assert.ok(name.length <= 64);
	const description = fields.description as string;
	assert.ok(description.length > 0 && description.length <= 1024, `description is ${description.length} chars`);
	for (const keyword of ["multi-step agent workflows", "reproducible", "sandboxed", "resumable"]) assert.match(description, new RegExp(keyword), keyword);
	assert.equal(fields.license, "MIT");
	assert.match(fields.compatibility as string, /Linux.*bubblewrap.*Node 26/);
	assert.ok((fields.compatibility as string).length <= 500);
	for (const key of Object.keys(fields)) assert.ok(["name", "description", "license", "compatibility", "metadata", "allowed-tools"].includes(key), `known field ${key}`);
	assert.ok(body.split("\n").length < 500, "the body is under 500 lines");
	// File references are relative and one level deep, and exist.
	for (const [, ref] of body.matchAll(/\]\(([^)#]+)\)/g)) {
		if (/^https?:/.test(ref!)) continue;
		assert.ok(ref!.split("/").length <= 2, `${ref} is one level deep`);
		assert.ok(existsSync(join(dir, ref!)), `${ref} exists`);
	}
	for (const sub of readdirSync(dir)) {
		if (!statSync(join(dir, sub)).isDirectory()) continue;
		assert.ok(["references", "assets", "scripts"].includes(sub), `known dir ${sub}`);
		for (const f of readdirSync(join(dir, sub))) assert.ok(statSync(join(dir, sub, f)).isFile(), `${sub}/${f} is a file (one level deep)`);
	}
	assert.ok(existsSync(join(dir, "references", "api.md")) && existsSync(join(dir, "references", "patterns.md")) && existsSync(join(dir, "assets", "workflow.ts")));
});

test("the skill's version is the package's", () => {
	const { fields } = frontmatter();
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
	assert.equal((fields.metadata as Record<string, string>).version, pkg.version);
});

/** The external tools run with the user's own caches (the tests point XDG_CACHE_HOME at a throwaway dir). */
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "XDG_CACHE_HOME"));
const reachable = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000, env }).status === 0;

test("the reference validator accepts it (skills-ref, via uvx)", { skip: !reachable("uvx", ["--offline", "--from", "skills-ref", "agentskills", "--version"]) && "uvx with skills-ref is not reachable offline", timeout: 120_000 }, () => {
	const r = spawnSync("uvx", ["--offline", "--from", "skills-ref", "agentskills", "validate", dir], { encoding: "utf8", timeout: 100_000, env });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /Valid skill/);
});

test("Vercel's skills CLI discovers it (npx skills add . --list)", { skip: !reachable("npx", ["--no-install", "skills", "--version"]) && "the skills CLI is not installed in npx's cache", timeout: 120_000 }, () => {
	const r = spawnSync("npx", ["--no-install", "skills", "add", root, "--list"], { encoding: "utf8", timeout: 100_000, cwd: root, env });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /wallis/);
	assert.match(r.stdout + r.stderr, /reproducible, resumable, sandboxed multi-step agent workflows/);
});
