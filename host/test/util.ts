// Test helpers: throwaway projects with the examples installed as
// `.agents/workflows/*`, and the CLI run as a child process.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function wallis(root: string, args: string[], env: Record<string, string> = {}) {
	// Plain detached hosts by default: SIGKILL tests must not be restarted by systemd.
	return spawnSync(process.execPath, [cli, ...args, "--root", root], { encoding: "utf8", env: { ...process.env, WALLIS_HOST: "plain", ...env }, timeout: 60_000 });
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
