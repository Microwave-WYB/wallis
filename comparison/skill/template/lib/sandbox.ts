// Run a subprocess in bubblewrap: read-only binds at fixed paths, one
// writable work dir, no network unless asked, optional GPUs, a clean env.
// Agents get no shell or fs on the host by default; give them a tool that
// runs *this* (see `tryRunTool`).

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import Type from "typebox";

export interface Box {
	/** host path -> path inside, read-only (code, data, the Python env). */
	readonly ro: Readonly<Record<string, string>>;
	/** Host dir mounted writable at /work: the only place it can write. */
	readonly work: string;
	readonly network?: boolean;
	readonly gpu?: boolean;
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}

export function sandboxed(argv: string[], box: Box): Promise<{ code: number; stdout: string; stderr: string }> {
	const a = ["--die-with-parent", "--new-session", "--unshare-all", "--clearenv", "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/etc", "/etc"];
	for (const d of ["/bin", "/sbin", "/lib", "/lib64"]) {
		if (existsSync(d)) a.push(...(lstatSync(d).isSymbolicLink() ? ["--symlink", readlinkSync(d), d] : ["--ro-bind", d, d]));
	}
	a.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", box.work, "/work", "--chdir", "/work");
	for (const [host, inside] of Object.entries(box.ro)) a.push("--ro-bind", host, inside);
	if (box.network) a.push("--share-net");
	if (box.gpu) for (const d of readdirSync("/dev").filter((n) => n.startsWith("nvidia"))) a.push("--dev-bind", `/dev/${d}`, `/dev/${d}`);
	for (const [k, v] of Object.entries({ PATH: "/usr/bin:/bin", HOME: "/work", ...box.env })) a.push("--setenv", k, v);
	return new Promise((done) => {
		const p = spawn("bwrap", [...a, "--", ...argv], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d));
		p.stderr.on("data", (d) => (stderr += d));
		const timer = box.timeoutMs ? setTimeout(() => p.kill("SIGKILL"), box.timeoutMs) : null;
		p.on("close", (code) => (timer && clearTimeout(timer), done({ code: code ?? 137, stdout, stderr })));
	});
}

/** Runs `harness/<script> /work/input.json /work/output.json` in a sandbox and returns the parsed output. */
export async function python<T>(harness: string, script: string, work: string, input: unknown, options: { gpu?: boolean; timeoutMs?: number } = {}): Promise<T> {
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "input.json"), JSON.stringify(input));
	const r = await sandboxed(["python3", `/harness/${script}`, "/work/input.json", "/work/output.json"], { ro: { [resolve(harness)]: "/harness" }, work, gpu: options.gpu, timeoutMs: options.timeoutMs ?? 3_600_000 });
	if (r.code !== 0) throw new Error(`${script} exited ${r.code}: ${r.stderr.slice(-2000)}`);
	return JSON.parse(readFileSync(join(work, "output.json"), "utf8")) as T;
}

/** An implementor's "try running my code" tool: its file runs in a fresh sandbox; only capped output returns. */
export function tryRunTool(scratch: string): AgentTool {
	return {
		name: "try_run",
		label: "try_run",
		description: "Run a Python file you write in a sandbox (no network, no host files); returns its exit code and output.",
		parameters: Type.Object({ file: Type.String({ pattern: "^[\\w.-]+\\.py$" }), code: Type.String() }),
		execute: async (_id, params) => {
			const { file, code } = params as { file: string; code: string };
			mkdirSync(scratch, { recursive: true });
			writeFileSync(join(scratch, file), code);
			const r = await sandboxed(["python3", file], { ro: {}, work: scratch, timeoutMs: 60_000 });
			return { content: [{ type: "text", text: `exit ${r.code}\n${r.stdout}${r.stderr}`.slice(0, 8_000) }], details: undefined, isError: r.code !== 0 };
		},
	};
}
