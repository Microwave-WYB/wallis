// Sandboxes, declared by the workflow (`defineSandbox`); the implementation
// is internal and bwrap only.
//
// Nothing is implicit. A sandbox sees:
//   /usr /etc /bin /lib*          the host base, read-only
//   /run/wallis/bin/<name>        each required binary, alone, read-only
//   /run/wallis/env               the setup env ($WALLIS_ENV), read-only
//   /run/wallis/inputs/<hex>/<n>  the call's input artifacts, read-only
//   /w                            the call's private scratch dir (cwd, writable)
//   /w/<mount>                    each declared mount, read-only
// and nothing else: not the workflow dir, not $HOME. The network is off
// for agents and commands, always; only `setup` and MCP servers whose
// overlay declares `network: "full"` (the default) share the host network.
// GPU devices are bound only for calls that declare `resources.gpu`.
//
// Binaries resolve per name: call-time `--bin` > local profile (per
// workflow, then global) > the caller's PATH when the run was created.
// The resolved paths are recorded in the run's metadata and reused on
// resume. Preflight runs each requirement's check inside the sandbox.
//
// `setup` runs once per digest (the declaration plus the content of its
// mounts and its binaries) with the network on, writing `$WALLIS_ENV`;
// afterwards every binary in `$WALLIS_ENV/bin` is smoke-tested the same way.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Refusal } from "../sdk/index.ts";
import type { Declarations } from "../sdk/runtime.ts";

export type SandboxDecl = Declarations["sandboxes"][string];

/** Paths inside a sandbox. */
export const LAYOUT = { work: "/w", inputs: "/run/wallis/inputs", bin: "/run/wallis/bin", env: "/run/wallis/env" } as const;

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

/** A sandbox's identity: its declaration, its binaries' paths and the content of its mounts. */
export function sandboxDigest(s: SandboxDecl, bins: Readonly<Record<string, string>>, mountDigests: Readonly<Record<string, string>>): string {
	const parts = { s, bins: s.requires.map((r) => [r.name, bins[r.name]]), mounts: s.mounts.map((m) => [m, mountDigests[m] ?? ""]) };
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

let bwrapChecked: boolean | null = null;

/** Whether bubblewrap can create a sandbox here (user namespaces may be off). */
export function bwrapAvailable(): boolean {
	if (bwrapChecked === null) {
		const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--", "/bin/true"], { stdio: "ignore" });
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

/** One process to start: `command args` with exactly `env` (secrets never on the command line). */
export interface Spawn {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string;
}

export interface CallDirs {
	readonly scratch: string;
	readonly inputs: string | null;
}

export interface SpawnOptions {
	readonly gpu?: boolean;
	/** Extra environment (secrets for MCP servers, WALLIS_COMPUTE_MINUTES). */
	readonly env?: Readonly<Record<string, string>>;
	/** MCP servers only: their overlay's network. Agents and commands never get one. */
	readonly network?: "none" | "full";
	/** Setup only: the network on and `$WALLIS_ENV` writable. */
	readonly setup?: { readonly envDir: string };
}

const head = (text: string) => text.trim().split("\n").slice(-12).join("\n").slice(-800);

/** The bwrap sandboxes of one run. */
export class Sandboxes {
	readonly #decls: Readonly<Record<string, SandboxDecl>>;
	readonly #bins: Readonly<Record<string, string>>;
	readonly #mounts: Readonly<Record<string, string>>;
	readonly #mountDigests: Readonly<Record<string, string>>;
	readonly #cache: string;
	readonly #envs = new Map<string, string>();

	constructor(options: {
		readonly decls: Readonly<Record<string, SandboxDecl>>;
		readonly bins: Readonly<Record<string, string>>;
		readonly mounts: Readonly<Record<string, string>>;
		readonly mountDigests: Readonly<Record<string, string>>;
		readonly cacheDir?: string;
	}) {
		this.#decls = options.decls;
		this.#bins = options.bins;
		this.#mounts = options.mounts;
		this.#mountDigests = options.mountDigests;
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
		const args = ["--die-with-parent", "--new-session", "--unshare-all"];
		if (options.setup || options.network === "full") args.push("--share-net");
		args.push(...systemMounts(), "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run/wallis");
		if (options.gpu) args.push(...gpuDevices());
		for (const r of s.requires) args.push("--ro-bind", this.#bins[r.name]!, `${LAYOUT.bin}/${r.name}`);
		if (envDir) args.push(options.setup ? "--bind" : "--ro-bind", envDir, LAYOUT.env);
		if (dirs.inputs) args.push("--ro-bind", dirs.inputs, LAYOUT.inputs);
		args.push("--bind", dirs.scratch, LAYOUT.work);
		for (const m of s.mounts) args.push("--ro-bind", this.#mounts[m]!, `${LAYOUT.work}/${m}`);
		args.push("--chdir", LAYOUT.work, "--");
		const program = argv[0] ?? "";
		args.push(program in this.#bins || s.requires.some((r) => r.name === program) ? `${LAYOUT.bin}/${program}` : program, ...argv.slice(1));
		const env: Record<string, string> = {
			PATH: [LAYOUT.bin, ...(envDir ? [`${LAYOUT.env}/bin`] : []), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
			HOME: LAYOUT.work,
			LANG: "C.UTF-8",
			WALLIS_SCRATCH: LAYOUT.work,
			WALLIS_INPUTS: LAYOUT.inputs,
			...(envDir ? { WALLIS_ENV: LAYOUT.env } : {}),
			...(options.env ?? {}),
		};
		return { command: "bwrap", args, env, cwd: dirs.scratch };
	}

	/** The setup digest: the declaration, its binaries and the content of its mounts. */
	digest(name: string): string {
		return sandboxDigest(this.#decl(name), this.#bins, this.#mountDigests);
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
			const sp = this.spawn(name, argv, { scratch, inputs: null }, options);
			const r = spawnSync(sp.command, sp.args, { env: sp.env, cwd: sp.cwd, encoding: "utf8", timeout: 600_000 });
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

/** Starts a sandboxed (or any) process; resolves with its result. Aborting kills it. */
export function runSpawn(
	sp: Spawn,
	stdin: string,
	options: { readonly timeoutMs?: number | null; readonly signal?: AbortSignal } = {},
): Promise<{ exit: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; minutes: number }> {
	const started = Date.now();
	return new Promise((done, fail) => {
		const child = spawn(sp.command, sp.args, { env: sp.env, cwd: existsSync(sp.cwd) ? sp.cwd : undefined, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = options.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), options.timeoutMs) : null;
		const onAbort = () => ((aborted = true), child.kill("SIGKILL"));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", fail);
		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			done({ exit: code ?? (signal ? 128 : 1), stdout, stderr, timedOut, aborted, minutes: (Date.now() - started) / 60_000 });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(stdin);
	});
}
