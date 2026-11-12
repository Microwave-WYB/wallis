// Sandboxes (docs/v2.md §4.4), bwrap only. Their two jobs (§1) are to
// prevent accidents and to make dependencies explicit: a call sees only
// what it was given. A sandbox sees:
//
//   /usr /etc /bin /sbin /lib*      the host base, read-only
//   <each required program>         read-only at its real path, with its install prefix's
//                                   lib, lib64, libexec and share; on PATH through
//                                   /run/wallis/bin, a dir of links to them alone
//   /in/<hex>/<name>                each input artifact, read-only (bound from the store)
//   /in/trees/<hex>                 each input Tree, read-only (its layers, overlaid)
//   /w                              the call's workspace (cwd, writable): a private dir,
//                                   or for an agent an overlay of its session's layers
//   <target>                        each volume: a bind read-only; a named volume writable,
//                                   except for agents
//   /tmp                            plain, ephemeral
//
// and nothing else: not the workflow dir, not $HOME. The network is off
// (`--unshare-all`, loopback only) unless the sandbox declares
// `network: "host"` (`--share-net`). Declared devices are dev-bound.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import type { ResolvedVolume } from "./volumes.ts";

/** Paths inside a sandbox. */
export const LAYOUT = { work: "/w", inputs: "/in", trees: "/in/trees", tmp: "/tmp", bin: "/run/wallis/bin" } as const;

/** What a sandbox is, resolved: its programs by name (real paths), volumes, environment, devices and network. */
export interface SandboxPlan {
	readonly programs: Readonly<Record<string, string>>;
	readonly volumes: readonly ResolvedVolume[];
	readonly environment: Readonly<Record<string, string>>;
	readonly devices: readonly string[];
	readonly network: "none" | "host";
}

export class SandboxError extends Error {
	override readonly name = "SandboxError";
}

// --- Host programs ---------------------------------------------------------------

/** The host's PATH as wallis found it, before anything else ran. */
const HOST_PATH = process.env.PATH ?? "";
const resolvedHost = new Map<string, string>();

/** A program wallis itself runs (bwrap, cp), by absolute real path from the host's PATH; the bare name if it is not found. */
export function hostProgram(name: string): string {
	let path = resolvedHost.get(name);
	if (path === undefined) {
		path = onPath(name, HOST_PATH) ?? name;
		resolvedHost.set(name, path);
	}
	return path;
}

/**
 * A program on PATH, by real path. Version-manager shim dirs (mise, asdf,
 * pyenv: `…/shims`) are skipped: a shim is a dispatcher that needs its
 * manager's config, which no sandbox has.
 */
function onPath(name: string, path: string): string | null {
	for (const dir of path.split(delimiter)) {
		if (!dir || !isAbsolute(dir) || /\/shims\/?$/.test(dir)) continue;
		const file = join(dir, name);
		try {
			accessSync(file, constants.X_OK);
			if (statSync(file).isFile()) return realpathSync(file);
		} catch {
			// not here
		}
	}
	return null;
}

/**
 * Every required program's real path, from `path` (default: this process's
 * PATH). A missing one is an error naming it: wallis checks that programs
 * exist, and their versions are the workflow's concern.
 */
export function resolvePrograms(requires: readonly string[], path = HOST_PATH): Record<string, string> {
	const out: Record<string, string> = {};
	const missing: string[] = [];
	for (const name of [...new Set(requires)].sort()) {
		// `node` falls back to the one running wallis (toolsets run under it).
		const found = name.includes("/") ? (isAbsolute(name) && existsSync(name) ? realpathSync(name) : null) : (onPath(name, path) ?? (name === "node" ? realpathSync(process.execPath) : null));
		if (found === null) missing.push(name);
		else out[name] = found;
	}
	if (missing.length > 0) throw new SandboxError(`required programs not found on PATH: ${missing.join(", ")}; install them or fix the sandbox's \`requires\``);
	return out;
}

/** The host base every sandbox sees read-only. */
const BASE = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib64"];

function underBase(path: string): boolean {
	return BASE.some((b) => path === b || path.startsWith(`${b}/`));
}

/** Where a program is installed: the dir above its `bin/` (so `../share`, `../lib` are found), else its own dir. */
export function installPrefix(program: string): string {
	const dir = dirname(program);
	return basename(dir) === "bin" ? dirname(dir) : dir;
}

const PREFIX_DIRS = ["lib", "lib64", "libexec", "share"];

/**
 * What a required program (its real path) needs bound, read-only at the
 * same paths: itself, and its install prefix's `lib`, `lib64`, `libexec` and
 * `share` where they exist. Not the prefix itself (its other programs), and
 * nothing of a prefix that is `/`, the home dir, a dir directly in it
 * (`~/.local`) or `/opt`, or that holds the project: then the program alone.
 * Nothing under the host base, which every sandbox has.
 */
export function programBinds(program: string, context: { readonly home?: string; readonly root?: string } = {}): string[] {
	if (underBase(program)) return [];
	const home = context.home ?? homedir();
	const prefix = installPrefix(program);
	const holds = (d: string) => context.root !== undefined && (context.root === d || context.root.startsWith(`${d}/`));
	const unsafe = prefix === "/" || prefix === home || dirname(prefix) === home || prefix === "/opt" || holds(prefix);
	const dirs = unsafe ? [] : PREFIX_DIRS.map((d) => join(prefix, d)).filter((d) => existsSync(d) && !underBase(d) && !holds(d));
	return [program, ...dirs];
}

function systemMounts(): string[] {
	const args: string[] = ["--ro-bind", "/usr", "/usr", "--ro-bind-try", "/etc", "/etc"];
	for (const d of ["/bin", "/sbin", "/lib", "/lib64"]) {
		if (!existsSync(d)) continue;
		if (lstatSync(d).isSymbolicLink()) args.push("--symlink", readlinkSync(d), d);
		else args.push("--ro-bind", d, d);
	}
	return args;
}

let bwrapChecked: boolean | null = null;

/** Whether bubblewrap can create a sandbox here (user namespaces may be off). */
export async function bwrapAvailable(): Promise<boolean> {
	if (bwrapChecked === null) {
		const { spawnSync } = await import("node:child_process");
		bwrapChecked = spawnSync(hostProgram("bwrap"), ["--ro-bind", "/", "/", "--unshare-all", "--", "/bin/true"], { stdio: "ignore" }).status === 0;
	}
	return bwrapChecked;
}

// --- One sandboxed process --------------------------------------------------------

/** What one call sees besides its sandbox: its workspace, input artifacts and Trees. */
export interface CallView {
	/** `/w`: a private dir, or an overlay of layers (bottom first) with the call's upper and work dirs. */
	readonly work: { readonly kind: "dir"; readonly dir: string } | { readonly kind: "overlay"; readonly lowers: readonly string[]; readonly upper: string; readonly ovl: string };
	/** Each input artifact: its path inside (`/in/<hex>/<name>`) and its blob in the store. */
	readonly inputs: readonly { readonly at: string; readonly file: string }[];
	/** Each input Tree: its path inside (`/in/trees/<hex>`) and its layers' dirs, bottom first. */
	readonly trees: readonly { readonly at: string; readonly lowers: readonly string[] }[];
	/** An agent's process: named volumes are read-only for it. */
	readonly agent?: boolean;
	/** Variables set inside, after the sandbox's own. */
	readonly env?: Readonly<Record<string, string>>;
}

export interface Spawn {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
}

/** The process that runs `argv` (argv[0] a required program, or a path inside the sandbox) in a sandbox. */
export function sandboxed(plan: SandboxPlan, argv: readonly string[], view: CallView, options: { readonly root?: string; readonly binCache?: string } = {}): Spawn {
	// --as-pid-1: the program is PID 1 of the sandbox, so /proc/1/cmdline is its own argv.
	const args = ["--die-with-parent", "--new-session", "--unshare-all", "--as-pid-1"];
	if (plan.network === "host") args.push("--share-net");
	args.push(...systemMounts(), "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run/wallis");
	for (const d of plan.devices) args.push("--dev-bind", d, d);
	for (const path of new Set(Object.values(plan.programs).flatMap((p) => programBinds(p, { root: options.root })))) args.push("--ro-bind", path, path);
	const binDir = programLinks(plan.programs, options.binCache);
	if (binDir) args.push("--ro-bind", binDir, LAYOUT.bin);
	// /in: a tmpfs holding each input, bound read-only from the store (no links, no copies), then read-only itself.
	args.push("--tmpfs", LAYOUT.inputs);
	for (const i of view.inputs) args.push("--ro-bind", i.file, i.at);
	for (const t of view.trees) {
		// bwrap's --ro-overlay needs two layers: none is an empty dir, one is a read-only bind.
		if (t.lowers.length === 0) args.push("--dir", t.at);
		else if (t.lowers.length === 1) args.push("--ro-bind", t.lowers[0]!, t.at);
		else {
			for (const l of t.lowers) args.push("--overlay-src", l);
			args.push("--ro-overlay", t.at);
		}
	}
	args.push("--remount-ro", LAYOUT.inputs);
	if (view.work.kind === "overlay" && view.work.lowers.length > 0) {
		for (const l of view.work.lowers) args.push("--overlay-src", l);
		args.push("--overlay", view.work.upper, view.work.ovl, LAYOUT.work);
	} else args.push("--bind", view.work.kind === "dir" ? view.work.dir : view.work.upper, LAYOUT.work);
	for (const v of plan.volumes) args.push(v.kind === "bind" || view.agent ? "--ro-bind" : "--bind", v.dir, v.target);
	const inside: Record<string, string> = {
		...plan.environment,
		PATH: [...(binDir ? [LAYOUT.bin] : []), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
		HOME: LAYOUT.work,
		LANG: plan.environment.LANG ?? "C.UTF-8",
		...(view.env ?? {}),
	};
	for (const [k, v] of Object.entries(inside)) args.push("--setenv", k, v);
	const program = argv[0] ?? "";
	const real = plan.programs[program];
	// Called by its real path, with the name it was asked for as argv[0] (clang++ -> clang, busybox).
	if (real !== undefined) args.push("--argv0", program);
	args.push("--chdir", LAYOUT.work, "--", real ?? program, ...argv.slice(1));
	return { command: hostProgram("bwrap"), args, cwd: view.work.kind === "dir" ? view.work.dir : view.work.upper };
}

/** A dir of links to the required programs not in the host base, by name, for PATH; null when there are none. */
function programLinks(programs: Readonly<Record<string, string>>, cache?: string): string | null {
	const links = Object.entries(programs).filter(([, p]) => !underBase(p)).sort(([a], [b]) => (a < b ? -1 : 1));
	if (links.length === 0) return null;
	const base = cache ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "wallis", "bins");
	const dir = join(base, createHash("sha256").update(JSON.stringify(links)).digest("hex").slice(0, 16));
	if (!existsSync(dir)) {
		const temp = `${dir}.${process.pid}.tmp`;
		rmSync(temp, { recursive: true, force: true });
		mkdirSync(temp, { recursive: true });
		for (const [link, target] of links) symlinkSync(target, join(temp, link));
		try {
			renameSync(temp, dir);
		} catch {
			rmSync(temp, { recursive: true, force: true });
		}
	}
	return dir;
}

export interface SpawnResult {
	readonly exit: number;
	/** The signal that killed it (the OOM killer's SIGKILL, say), or null. */
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly ms: number;
	readonly aborted: boolean;
}

/** Runs a sandboxed process with `stdin`; resolves with its result. Aborting kills it. */
export function runSpawn(sp: Spawn, stdin: string, options: { readonly signal?: AbortSignal } = {}): Promise<SpawnResult> {
	const started = Date.now();
	return new Promise((done, fail) => {
		const child = spawn(sp.command, sp.args, { cwd: existsSync(sp.cwd) ? sp.cwd : undefined, stdio: ["pipe", "pipe", "pipe"], env: {} });
		// Bytes, decoded once at the end: a multibyte character split across chunks stays whole.
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let aborted = false;
		child.stdout.on("data", (d: Buffer) => out.push(d));
		child.stderr.on("data", (d: Buffer) => err.push(d));
		const onAbort = () => ((aborted = true), child.kill("SIGKILL"));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", fail);
		child.on("close", (code, signal) => {
			options.signal?.removeEventListener("abort", onAbort);
			// bwrap as pid 1's parent reports a killed child as 128 + n.
			const killed = signal ?? (code !== null && code > 128 && code < 160 ? signalName(code - 128) : null);
			done({ exit: code ?? 128, signal: killed, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), ms: Date.now() - started, aborted });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(stdin);
	});
}

function signalName(n: number): string {
	const names: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 6: "SIGABRT", 9: "SIGKILL", 11: "SIGSEGV", 13: "SIGPIPE", 15: "SIGTERM" };
	return names[n] ?? `signal ${n}`;
}

/** The last lines of a process's output, for a failure message. */
export function head(text: string): string {
	return text.trim().split("\n").slice(-12).join("\n").slice(-800);
}
