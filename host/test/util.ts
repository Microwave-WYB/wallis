// Test helpers: throwaway projects with the examples installed as
// `.agents/workflows/*`, and the CLI run as a child process.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Every host session in a test (and every CLI host it starts) checks after each event that the
// state rebuilt from the log equals the live state (Session #differential).
process.env.WALLIS_DIFFERENTIAL = "1";

const here = fileURLToPath(new URL(".", import.meta.url));
export const cli = resolve(here, "../src/cli/main.ts");
export const fakeExecutor = resolve(here, "fixtures/fake-executor.ts");

export function tmp(prefix = "wallis-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** A project with the `ask` and `two-node` examples and the `fanout` fixture as workflows. */
export function project(): string {
	const root = tmp("wallis-project-");
	for (const name of ["ask", "two-node"]) {
		cpSync(resolve(here, "../examples", name), join(root, ".agents", "workflows", name), { recursive: true, filter: (f) => !f.endsWith("run.ts") });
	}
	cpSync(resolve(here, "fixtures/fanout"), join(root, ".agents", "workflows", "fanout"), { recursive: true });
	return root;
}

/**
 * The environment of a CLI call, the same inside and outside a harness:
 * no inherited identity, and a harness list nothing matches, so the
 * caller is the human unless a test sets `WALLIS_OWNER` (or its own
 * `WALLIS_HARNESSES`). Plain detached hosts: SIGKILL tests must not be
 * restarted by systemd.
 */
export function cliEnv(env: Record<string, string> = {}): Record<string, string> {
	const { WALLIS_OWNER: _owner, WALLIS_HARNESSES: _harnesses, ...rest } = process.env;
	return { ...(rest as Record<string, string>), WALLIS_HOST: "plain", WALLIS_HARNESSES: "no-harness-in-tests", ...env };
}

export function wallis(root: string, args: string[], env: Record<string, string> = {}) {
	return spawnSync(process.execPath, [cli, ...args, "--root", root], { encoding: "utf8", env: cliEnv(env), timeout: 60_000 });
}

export function onlyRun(root: string): string {
	const runs = readdirSync(join(root, ".wallis", "runs")).sort();
	return runs.at(-1)!;
}

export function runDir(root: string, id: string): string {
	return join(root, ".wallis", "runs", id);
}

export function logOf(root: string, id: string): Record<string, unknown>[] {
	return lines(join(runDir(root, id), "log.jsonl"));
}

export function lines(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter((l) => l)
		.map((l) => JSON.parse(l));
}

/** Message ids are chosen by the sender; everything else must match. */
export function normalized(log: Record<string, unknown>[]): unknown[] {
	return log.map((e) => (e.type === "sent" ? { ...e, message_id: "<id>" } : e));
}
