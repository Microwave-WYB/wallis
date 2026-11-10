// Sandboxes, declared by the workflow (`defineSandbox`); the implementation
// is internal and bwrap only.
//
// Nothing is implicit. A sandbox sees:
//   /usr /etc /bin /lib*          the host base, read-only
//   <prefix of each required program>  read-only at its own path: a program is called by its
//                                 real path, so what it finds relative to itself is there
//   /run/wallis/env               the setup env ($WALLIS_ENV), read-only
//   /in/<hex>/<n>                 the call's input artifacts, read-only
//   /in/trees/<hex>               each Tree in its input, read-only
//   /w                            the call's workspace (cwd, writable): for an
//                                 agent, an overlay of its session's layers
//                                 with the call's own upper dir; for a
//                                 command, a private dir
//   <target>                      each declared volume: a bind read-only,
//                                 a named volume writable
//   /tmp                          plain, ephemeral
// and nothing else: not the workflow dir, not $HOME. The network is off
// for agents and commands, always; only `setup` and MCP servers whose
// overlay declares `network: "host"` (the default), and sandboxes declaring it, share the host network.
// Declared `devices` are dev-bound as declared; GPU devices are also bound
// for calls that declare `resources.gpu`. `environment` is set as declared.
//
// Binaries resolve per name: call-time `--bin` > local profile (per
// workflow, then global) > the caller's PATH when the run was created.
// The resolved paths are recorded in the run's metadata and reused on
// resume. Preflight runs each requirement's check inside the sandbox.
//
// `setup` runs once per digest (the declaration plus the content of its
// bind volumes and its binaries) with the network on, writing `$WALLIS_ENV`;
// afterwards every binary in `$WALLIS_ENV/bin` is smoke-tested the same way.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import type { Json, Refusal } from "../sdk/index.ts";
import type { Declarations } from "../sdk/runtime.ts";
import { canonical } from "./render.ts";
import { hostEnv, hostProgram, sandboxEnvProblem, secretEnvProblem } from "./hostbin.ts";
import { inScope, type LimitHit, LimitsUnavailable, type Scope, scopeFor, scopeResult, watchScope } from "./limits.ts";
import type { ResolvedVolume } from "./volumes.ts";

export type SandboxDecl = Declarations["sandboxes"][string];

/** Paths inside a sandbox. */
export const LAYOUT = { work: "/w", inputs: "/in", trees: "/in/trees", tmp: "/tmp", bin: "/run/wallis/bin", env: "/run/wallis/env" } as const;

export class SandboxError extends Error {
	override readonly name = "SandboxError";
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(`sandbox refused: ${JSON.stringify(refusal)}`);
		this.refusal = refusal;
	}
}

export interface BinProfile {
	readonly global?: Readonly<Record<string, string>>;
	readonly workflows?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Every binary the sandboxes require, by name: an absolute real path, or `requires_missing`. */
export function resolveBins(
	workflow: string,
	sandboxes: Readonly<Record<string, SandboxDecl>>,
	options: { readonly callTime?: Readonly<Record<string, string>>; readonly profile?: BinProfile; readonly path?: string },
): Record<string, string> {
	const names = [...new Set(Object.values(sandboxes).flatMap((s) => s.requires.map((r) => r.name)))].sort();
	for (const name of Object.keys(options.callTime ?? {})) if (!names.includes(name)) throw new SandboxError({ type: "unknown_bin", name });
	const out: Record<string, string> = {};
	for (const name of names) {
		const given = options.callTime?.[name] ?? options.profile?.workflows?.[workflow]?.[name] ?? options.profile?.global?.[name];
		const found = given ?? onPath(name, options.path ?? "");
		if (!found || !existsSync(found)) throw new SandboxError({ type: "requires_missing", name });
		out[name] = realpathSync(found);
	}
	return out;
}

function onPath(name: string, path: string): string | null {
	for (const dir of path.split(delimiter)) {
		if (!dir || !isAbsolute(dir)) continue;
		const file = join(dir, name);
		try {
			if (statSync(file).isFile()) return file;
		} catch {
			// not here
		}
	}
	return null;
}

/** The host base every sandbox sees read-only (`systemMounts`). */
const BASE = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib64"];

function underBase(path: string): boolean {
	return BASE.some((b) => path === b || path.startsWith(`${b}/`));
}

/**
 * Where a program is installed: the dir above its `bin/` (so `../share`,
 * `../lib` are found), else its own dir.
 */
export function installPrefix(program: string): string {
	const dir = dirname(program);
	return basename(dir) === "bin" ? dirname(dir) : dir;
}

/** The dirs of an install prefix a program may find relative to itself. */
const PREFIX_DIRS = ["lib", "lib64", "libexec", "share"];

/**
 * What a required program (its real path) needs bound, read-only at the
 * same paths: the program itself, and those of its install prefix's `lib`,
 * `lib64`, `libexec` and `share` that exist. Never the prefix itself (its
 * other programs, its data), and nothing of a prefix that is `/`, the home
 * dir or a dir directly in it (`~/.local`, `~/.cargo`), `/opt`, or that
 * holds the project (its prompts, its runs): then the program alone.
 * Nothing under the host base, which every sandbox has.
 */
export function programBinds(program: string, context: { readonly home?: string; readonly root?: string } = {}): string[] {
	if (underBase(program)) return [];
	const home = context.home ?? homedir();
	const prefix = installPrefix(program);
	const unsafe =
		prefix === "/" || prefix === home || dirname(prefix) === home || prefix === "/opt" || (context.root !== undefined && (context.root === prefix || context.root.startsWith(`${prefix}/`)));
	const dirs = unsafe ? [] : PREFIX_DIRS.map((d) => join(prefix, d)).filter((d) => existsSync(d) && !underBase(d) && !(context.root !== undefined && (context.root === d || context.root.startsWith(`${d}/`))));
	return [program, ...dirs];
}

/** The host base, recorded in run metadata. */
export function baseIdentity(): { distro: string; kernel: string } {
	let distro = "unknown";
	try {
		const os = Object.fromEntries(
			readFileSync("/etc/os-release", "utf8")
				.split("\n")
				.filter((l) => l.includes("="))
				.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
		);
		distro = [os.PRETTY_NAME ?? os.NAME ?? os.ID, os.VERSION_ID].filter(Boolean).join(" ");
	} catch {
		// no os-release
	}
	return { distro, kernel: release() };
}

/**
 * A sandbox's identity: its declaration, its binaries' paths and the
 * content of its bind volumes (by target). Named volumes are left out: they
 * are caches, and results must not depend on them.
 */
export function sandboxDigest(s: SandboxDecl, bins: Readonly<Record<string, string>>, bindDigests: Readonly<Record<string, string>>): string {
	// Canonical JSON (sorted keys): the same declaration is the same digest whatever order its keys were written in.
	// Limits are left out too: a result must not depend on them (hitting one is a failure).
	const { mem_limit: _mem, pids_limit: _pids, ...declared } = s;
	const parts = { s: declared, bins: s.requires.map((r) => [r.name, bins[r.name] ?? null]), binds: bindDigests };
	return createHash("sha256").update(canonical(JSON.parse(JSON.stringify(parts)) as Json)).digest("hex");
}

let bwrapChecked: boolean | null = null;

/** Whether bubblewrap can create a sandbox here (user namespaces may be off). */
export function bwrapAvailable(): boolean {
	if (bwrapChecked === null) {
		const r = spawnSync(hostProgram("bwrap"), ["--ro-bind", "/", "/", "--unshare-all", "--", "/bin/true"], { stdio: "ignore", env: hostEnv() });
		bwrapChecked = r.status === 0;
	}
	return bwrapChecked;
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

function gpuDevices(): string[] {
	const devices = existsSync("/dev") ? readdirSync("/dev").filter((d) => /^nvidia/.test(d)).map((d) => `/dev/${d}`) : [];
	if (existsSync("/dev/dri")) devices.push("/dev/dri");
	return devices.flatMap((d) => ["--dev-bind", d, d]);
}

/**
 * One sandboxed process: bwrap `args` with exactly `env` (secrets never on
 * the command line), started only in its `scope` (`launch`): its memory and
 * process limits.
 */
export interface Spawn {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string;
	readonly scope: Scope;
}

/**
 * How a sandboxed process is started: in its scope (`limits.ts`);
 * `limits_unavailable` without a user manager. `observed`: its runner reads
 * the scope's result afterwards (`runSpawn`).
 */
export function launch(sp: Spawn, options: { readonly observed?: boolean } = {}): { command: string; args: string[]; env: Record<string, string> } {
	try {
		return inScope(sp.scope, sp.command, sp.args, sp.env, options);
	} catch (error) {
		if (error instanceof LimitsUnavailable) throw new SandboxError({ type: "limits_unavailable", reason: error.reason });
		throw error;
	}
}

export interface CallDirs {
	/** `/w`: a private dir, or (with `layers`) the overlay's upper dir. */
	readonly scratch: string;
	readonly inputs: string | null;
	/** An agent's workspace: its session's layers (bottom first) and overlayfs's work dir. */
	readonly overlay?: { readonly lowers: readonly string[]; readonly ovl: string };
	/** Trees in the input: each read-only at `/in/trees/<hex>`, as an overlay of its layers. */
	readonly trees?: readonly { readonly at: string; readonly lowers: readonly string[] }[];
}

export interface SpawnOptions {
	readonly gpu?: boolean;
	/** A command's `resources.memoryGb`: its memory limit in place of the default (capped by `mem_limit`). */
	readonly memoryGb?: number;
	/** Variables set inside (`WALLIS_COMPUTE_MINUTES`), with `--setenv`. */
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * Secrets (a toolset's, an MCP server's): carried in the environment of
	 * the host-side bwrap, so they never appear on a command line; nothing
	 * else is in that environment.
	 */
	readonly secrets?: Readonly<Record<string, string>>;
	/** MCP servers only: their overlay's network. Agents and commands never get one. */
	readonly network?: "none" | "host";
	/** An agent's process: named volumes are read-only for it (writable only for commands and tool sources). */
	readonly agent?: boolean;
	/** Setup only: the network on and `$WALLIS_ENV` writable. */
	readonly setup?: { readonly envDir: string };
}

const head = (text: string) => text.trim().split("\n").slice(-12).join("\n").slice(-800);

/** The bwrap sandboxes of one run. */
export class Sandboxes {
	readonly #decls: Readonly<Record<string, SandboxDecl>>;
	readonly #bins: Readonly<Record<string, string>>;
	readonly #volumes: Readonly<Record<string, readonly ResolvedVolume[]>>;
	readonly #root: string | undefined;
	readonly #bindDigests: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly #cache: string;
	readonly #envs = new Map<string, string>();

	constructor(options: {
		readonly decls: Readonly<Record<string, SandboxDecl>>;
		readonly bins: Readonly<Record<string, string>>;
		/** Each sandbox's volumes, resolved. */
		readonly volumes: Readonly<Record<string, readonly ResolvedVolume[]>>;
		/** Each sandbox's bind volumes' content digests, by target. */
		readonly bindDigests: Readonly<Record<string, Readonly<Record<string, string>>>>;
		readonly cacheDir?: string;
		/** The project root: no required program's binds may hold it. */
		readonly root?: string;
	}) {
		this.#root = options.root;
		this.#decls = options.decls;
		this.#bins = options.bins;
		this.#volumes = options.volumes;
		this.#bindDigests = options.bindDigests;
		this.#cache = options.cacheDir ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "wallis", "envs");
	}

	#decl(name: string): SandboxDecl {
		const d = this.#decls[name];
		if (!d) throw new Error(`no sandbox ${name}`);
		return d;
	}

	/** The process that runs `argv` (argv[0] a required binary, or a path inside the sandbox) in sandbox `name`. */
	spawn(name: string, argv: readonly string[], dirs: CallDirs, options: SpawnOptions = {}): Spawn {
		const s = this.#decl(name);
		const envDir = options.setup?.envDir ?? this.#envs.get(name) ?? null;
		// --as-pid-1: the program is PID 1 of the sandbox, not bwrap, so /proc/1/cmdline is its own argv,
		// never bwrap's (host paths of binds and prefixes, --setenv values).
		const args = ["--die-with-parent", "--new-session", "--unshare-all", "--as-pid-1"];
		if (options.setup || options.network === "host" || s.network === "host") args.push("--share-net");
		args.push(...systemMounts(), "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run/wallis");
		if (options.gpu) args.push(...gpuDevices());
		for (const d of s.devices) args.push("--dev-bind", d, d);
		// Each required program stays where it is, called by its real path, with only the parts of
		// its install prefix it may find relative to itself (programBinds). On PATH is a dir of links
		// to the required programs alone, never the dirs they are in.
		for (const path of new Set(s.requires.flatMap((r) => programBinds(this.#bins[r.name]!, { root: this.#root })))) args.push("--ro-bind", path, path);
		const binDir = this.#binDir(name);
		if (binDir) args.push("--ro-bind", binDir, LAYOUT.bin);
		if (envDir) args.push(options.setup ? "--bind" : "--ro-bind", envDir, LAYOUT.env);
		if (dirs.inputs) args.push("--ro-bind", dirs.inputs, LAYOUT.inputs);
		for (const t of dirs.trees ?? []) {
			// bwrap's --ro-overlay needs two layers: none is an empty dir, one is a read-only bind.
			if (t.lowers.length === 0) args.push("--tmpfs", t.at, "--remount-ro", t.at);
			else if (t.lowers.length === 1) args.push("--ro-bind", t.lowers[0]!, t.at);
			else {
				for (const l of t.lowers) args.push("--overlay-src", l);
				args.push("--ro-overlay", t.at);
			}
		}
		// An agent's /w: the kernel's overlay of its session's layers and the call's upper dir.
		if (dirs.overlay && dirs.overlay.lowers.length > 0) {
			for (const l of dirs.overlay.lowers) args.push("--overlay-src", l);
			args.push("--overlay", dirs.scratch, dirs.overlay.ovl, LAYOUT.work);
		} else args.push("--bind", dirs.scratch, LAYOUT.work);
		// Volumes at their targets: a bind read-only; a named volume (a cache) writable for commands and
		// tool sources, read-only for an agent (its writes would reach later runs outside every key).
		for (const v of this.#volumes[name] ?? []) args.push(v.kind === "bind" || options.agent ? "--ro-bind" : "--bind", v.dir, v.target);
		const program = argv[0] ?? "";
		const required = s.requires.some((r) => r.name === program) && this.#bins[program] !== undefined;
		// Called by its real path, but with the name it was asked for as argv[0]: programs that
		// dispatch on it (clang++ -> clang, busybox, ld) behave as that name.
		if (required) args.push("--argv0", program);
		args.push("--chdir", LAYOUT.work, "--");
		args.push(required ? this.#bins[program]! : program, ...argv.slice(1));
		// The environment inside: set with --setenv, never through the host-side spawn's own.
		for (const key of Object.keys(s.environment)) {
			const reason = sandboxEnvProblem(key);
			if (reason !== null) throw new SandboxError({ type: "invalid_environment", sandbox: name, key, reason });
		}
		const inside: Record<string, string> = {
			...s.environment,
			PATH: [...(binDir ? [LAYOUT.bin] : []), ...(envDir ? [`${LAYOUT.env}/bin`] : []), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
			HOME: LAYOUT.work,
			LANG: "C.UTF-8",
			WALLIS_SCRATCH: LAYOUT.work,
			WALLIS_INPUTS: LAYOUT.inputs,
			...(envDir ? { WALLIS_ENV: LAYOUT.env } : {}),
			...(options.env ?? {}),
		};
		const setenv = Object.entries(inside).flatMap(([k, v]) => ["--setenv", k, v]);
		const at = args.indexOf("--chdir");
		args.splice(at, 0, ...setenv);
		for (const key of Object.keys(options.secrets ?? {})) {
			const reason = secretEnvProblem(key);
			if (reason !== null) throw new SandboxError({ type: "invalid_environment", sandbox: name, key, reason });
		}
		const scope = scopeFor(s, options.memoryGb ? { memoryGb: options.memoryGb } : {});
		return { command: hostProgram("bwrap"), args, env: { ...(options.secrets ?? {}) }, cwd: dirs.scratch, scope };
	}

	/**
	 * A sandbox's dir of links to its required programs that are not in the
	 * host base, by name (`<cache>/../bins/<hash>`), for PATH; null when
	 * there are none.
	 */
	#binDir(name: string): string | null {
		const s = this.#decl(name);
		const links = s.requires.flatMap((r) => (this.#bins[r.name] && !underBase(this.#bins[r.name]!) ? [[r.name, this.#bins[r.name]!] as const] : []));
		if (links.length === 0) return null;
		const dir = join(dirname(this.#cache), "bins", createHash("sha256").update(JSON.stringify(links)).digest("hex").slice(0, 16));
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

	/** The setup digest: the declaration, its binaries and the content of its bind volumes. */
	digest(name: string): string {
		return sandboxDigest(this.#decl(name), this.#bins, this.#bindDigests[name] ?? {});
	}

	/**
	 * Preflight: every requirement's check inside its sandbox, and each
	 * sandbox's setup (cached by digest). Returns the versions found, for
	 * run metadata only (never the pin).
	 */
	prepare(log: (text: string) => void = () => {}): Record<string, string> {
		const versions: Record<string, string> = {};
		for (const [name, s] of Object.entries(this.#decls)) {
			if (s.setup.length > 0) this.#setup(name, log);
			for (const r of s.requires) {
				const out = this.#runSync(name, r.check);
				if (out.status !== 0) throw new SandboxError({ type: "requires_broken", name: r.name, exit: out.status, stderr_head: head(out.stderr || out.stdout) });
				versions[r.name] ??= out.stdout.trim().split("\n")[0] ?? "";
			}
		}
		return versions;
	}

	#runSync(name: string, argv: readonly string[], options: SpawnOptions = {}): { status: number; stdout: string; stderr: string } {
		const scratch = mkdtempSync(join(tmpdir(), "wallis-check-"));
		try {
			const sp = launch(this.spawn(name, argv, { scratch, inputs: null }, options));
			const r = spawnSync(sp.command, sp.args, { env: sp.env, cwd: scratch, encoding: "utf8", timeout: 600_000 });
			return { status: r.status ?? 128, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	#setup(name: string, log: (text: string) => void): void {
		const dir = join(this.#cache, this.digest(name));
		const ready = join(dir, ".wallis-ready");
		if (!existsSync(ready)) {
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true });
			log(`setup of sandbox ${name} (${this.digest(name).slice(0, 12)}), network on`);
			for (const step of this.#decl(name).setup) {
				const out = this.#runSync(name, step, { setup: { envDir: dir } });
				if (out.status !== 0) throw new SandboxError({ type: "setup_failed", sandbox: name, exit: out.status, stderr_head: head(out.stderr || out.stdout) });
			}
			this.#envs.set(name, dir);
			// Smoke test: every binary the setup produced must actually run (shims included).
			const bin = join(dir, "bin");
			for (const file of existsSync(bin) ? readdirSync(bin).sort() : []) {
				const out = this.#runSync(name, [`${LAYOUT.env}/bin/${file}`, "--version"]);
				if (out.status !== 0) throw new SandboxError({ type: "setup_failed", sandbox: name, exit: out.status, stderr_head: head(`${file}: ${out.stderr || out.stdout}`) });
			}
			writeFileSync(ready, `${new Date().toISOString()}\n`);
		}
		this.#envs.set(name, dir);
	}
}

/**
 * Starts a sandboxed process in its scope; resolves with its result.
 * Aborting kills it; a limit hit stops its whole scope and is `limit`.
 */
export function runSpawn(
	sp: Spawn,
	stdin: string,
	options: { readonly timeoutMs?: number | null; readonly signal?: AbortSignal } = {},
): Promise<{ exit: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; minutes: number; limit: LimitHit | null }> {
	const started = Date.now();
	const scoped = launch(sp, { observed: true });
	return new Promise((done, fail) => {
		const child = spawn(scoped.command, scoped.args, { env: scoped.env, cwd: existsSync(sp.cwd) ? sp.cwd : undefined, stdio: ["pipe", "pipe", "pipe"] });
		const watch = child.pid === undefined ? null : watchScope(child.pid, sp.scope, () => child.kill("SIGKILL"));
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = options.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), options.timeoutMs) : null;
		const onAbort = () => ((aborted = true), child.kill("SIGKILL"));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => (watch?.stop(), fail(error)));
		child.on("exit", () => watch?.stop());
		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			watch?.stop();
			const exit = code ?? (signal ? 128 : 1);
			const result = { exit, stdout, stderr, timedOut, aborted, minutes: (Date.now() - started) / 60_000 };
			const seen = watch?.hit() ?? null;
			if (exit < 128) return done({ ...result, limit: seen });
			// Killed by a signal: the OOM killer may have ended the scope before the watch saw it (systemd
			// recorded it), and a failed scope is cleared either way. Our own kills are not limits.
			const recorded = (limit: LimitHit | null) => done({ ...result, limit: seen ?? (timedOut || aborted ? null : limit) });
			void scopeResult(sp.scope).then(recorded, () => recorded(null));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(stdin);
	});
}
