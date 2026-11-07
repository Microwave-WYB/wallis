// Runs a workflow's domain scripts (`scripts/<name>.{py,sh,mjs,js,ts}`) as
// processes. A script reads its JSON args on stdin and writes its JSON
// output on stdout. Files it hands downstream are artifact drafts
// (`{ "artifact": "<path in $WALLIS_SCRATCH>", "media": "..." }`).
//
// Confinement (bubblewrap on Linux): the system dirs read-only, the
// interpreter and the scripts dir read-only, the node's input artifacts and
// declared mounts read-only, its scratch dir writable, no network, a
// clean environment. Nothing else of the filesystem is visible.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { Json } from "../sdk/index.ts";
import type { NodeDirs } from "./artifacts.ts";
import type { ScriptCall, ScriptResult, ScriptRunner } from "./executor.ts";
import { scoped, type Slots } from "./slots.ts";

export type Confinement = "bwrap" | "none";

let bwrapChecked: boolean | null = null;

/** Whether bubblewrap can create a sandbox here (user namespaces may be off). */
export function bwrapAvailable(): boolean {
	if (bwrapChecked === null) {
		const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--", "/bin/true"], { stdio: "ignore" });
		bwrapChecked = r.status === 0;
	}
	return bwrapChecked;
}

const EXTENSIONS = [".py", ".sh", ".mjs", ".js", ".ts"];

function interpreter(file: string): string {
	switch (extname(file)) {
		case ".py":
			return existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
		case ".sh":
			return "/bin/sh";
		default:
			return process.execPath;
	}
}

/** System mounts: real dirs are bound read-only, merged-/usr symlinks are recreated. */
function systemMounts(): string[] {
	const args: string[] = ["--ro-bind", "/usr", "/usr", "--ro-bind-try", "/etc", "/etc"];
	for (const d of ["/bin", "/sbin", "/lib", "/lib64"]) {
		if (!existsSync(d)) continue;
		const st = lstatSync(d);
		if (st.isSymbolicLink()) args.push("--symlink", readlinkSync(d), d);
		else args.push("--ro-bind", d, d);
	}
	return args;
}

export function bwrapArgs(dirs: NodeDirs, readOnly: readonly string[]): string[] {
	const args = ["--die-with-parent", "--new-session", "--unshare-all", "--clearenv", ...systemMounts(), "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
	for (const path of new Set(readOnly)) args.push("--ro-bind", path, path);
	if (dirs.level !== "none") args.push("--ro-bind", dirs.inputs, dirs.inputs);
	for (const path of Object.values(dirs.mounts)) args.push("--ro-bind", path, path);
	if (dirs.scratch) args.push("--bind", dirs.scratch, dirs.scratch);
	args.push("--chdir", dirs.scratch ?? "/tmp");
	return args;
}

export interface ProcessScriptsOptions {
	/** The workflow's directory; scripts live in its `scripts/`. */
	readonly workflowDir: string;
	/** `auto`: bwrap when available, else unconfined with a warning; `require`: refuse without bwrap. */
	readonly confine?: "auto" | "require" | "off";
	/** Machine-wide resource slots; see slots.ts. */
	readonly slots?: Slots;
}

export class ScriptError extends Error {}

export class ProcessScripts implements ScriptRunner {
	readonly #options: ProcessScriptsOptions;
	readonly confinement: Confinement;

	constructor(options: ProcessScriptsOptions) {
		this.#options = options;
		const confine = options.confine ?? "auto";
		if (confine === "off") this.confinement = "none";
		else if (bwrapAvailable()) this.confinement = "bwrap";
		else if (confine === "require") throw new ScriptError("bubblewrap is required to confine scripts but cannot create a sandbox here");
		else {
			process.stderr.write("wallis: bubblewrap is unavailable; scripts run unconfined\n");
			this.confinement = "none";
		}
	}

	#file(name: string): string {
		const dir = join(this.#options.workflowDir, "scripts");
		for (const ext of EXTENSIONS) {
			const file = join(dir, `${name}${ext}`);
			if (existsSync(file)) return file;
		}
		throw new ScriptError(`no script ${name} in ${dir}`);
	}

	async run(call: ScriptCall): Promise<ScriptResult> {
		const file = this.#file(call.script);
		const run = () => this.#spawn(call, file);
		return this.#options.slots ? this.#options.slots.withSlot(call.resources, run) : run();
	}

	#spawn(call: ScriptCall, file: string): Promise<ScriptResult> {
		const dirs = call.workspace;
		const env: Record<string, string> = {
			PATH: "/usr/local/bin:/usr/bin:/bin",
			HOME: dirs.scratch ?? "/tmp",
			LANG: "C.UTF-8",
			WALLIS_INPUTS: dirs.inputs,
			WALLIS_SCRATCH: dirs.scratch ?? "",
			WALLIS_COMPUTE_MINUTES: call.computeMinutes === null ? "" : String(call.computeMinutes),
		};
		for (const [name, path] of Object.entries(dirs.mounts)) env[`WALLIS_MOUNT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = path;
		const exe = interpreter(file);
		let command: string;
		let argv: string[];
		if (this.confinement === "bwrap") {
			const readOnly = [resolve(dirname(file))];
			if (!exe.startsWith("/usr/") && !exe.startsWith("/bin/")) readOnly.push(resolve(dirname(exe), ".."));
			const setenv = Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]);
			command = "bwrap";
			argv = [...bwrapArgs(dirs, readOnly), ...setenv, "--", exe, file];
		} else {
			command = exe;
			argv = [file];
		}
		[command, argv] = scoped(command, argv, call.resources.memoryGb);
		const started = Date.now();
		return new Promise<ScriptResult>((done, fail) => {
			const child = spawn(command, argv, { env: this.confinement === "bwrap" ? process.env : { ...process.env, ...env }, cwd: dirs.scratch ?? undefined, stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			const limit = call.computeMinutes === null ? null : Math.max(1, call.computeMinutes * 60_000);
			const timer = limit === null ? null : setTimeout(() => child.kill("SIGKILL"), limit);
			child.on("error", (e) => fail(new ScriptError(`${call.script}: ${e.message}`)));
			child.on("close", (code, signal) => {
				if (timer) clearTimeout(timer);
				const minutes = (Date.now() - started) / 60_000;
				if (code !== 0) return fail(new ScriptError(`${call.script} exited ${signal ?? code}: ${stderr.trim().slice(-500)}`));
				try {
					done({ output: JSON.parse(stdout) as unknown, minutes });
				} catch {
					fail(new ScriptError(`${call.script} wrote no JSON on stdout: ${stdout.slice(0, 200)}`));
				}
			});
			child.stdin.end(JSON.stringify(call.args));
		});
	}
}
