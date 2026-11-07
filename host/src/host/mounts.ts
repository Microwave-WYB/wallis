// Mounts: named, read-only host dirs, declared like models
// (`defineMounts({ kb: "./knowledge", data: "" })`).
//
// Resolution per name: call-time > local profile (per-workflow beats global)
// > the declared default, which resolves against the workflow dir. An empty
// value is a preflight error (`mount_unset`). Call-time and profile paths
// resolve against the project root.
//
// Each mount's content digest goes into the pin (`inputs.mount.<name>`).
// Per-file hashes are cached by path, mtime and size in
// `$XDG_CACHE_HOME/wallis/file-hashes.json`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Refusal } from "../sdk/index.ts";

export interface MountProfile {
	readonly global?: Readonly<Record<string, string>>;
	readonly workflows?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** A resolved mount: always read-only, there is no writable variant. */
export interface Mount {
	readonly name: string;
	readonly dir: string;
}

export class MountError extends Error {
	override readonly name = "MountError";
	readonly refusal: Refusal;
	constructor(refusal: Refusal, message: string) {
		super(message);
		this.refusal = refusal;
	}
}

export function resolveMounts(
	workflow: string,
	workflowDir: string,
	table: Readonly<Record<string, string>>,
	options: { readonly root: string; readonly callTime?: Readonly<Record<string, string>>; readonly profile?: MountProfile },
): Record<string, Mount> {
	for (const name of Object.keys(options.callTime ?? {})) {
		if (!(name in table)) throw new Error(`unknown mount ${name}`);
	}
	const out: Record<string, Mount> = {};
	for (const name of Object.keys(table).sort()) {
		const remap = options.callTime?.[name] || options.profile?.workflows?.[workflow]?.[name] || options.profile?.global?.[name];
		const value = remap ? resolve(options.root, remap) : table[name] ? resolve(workflowDir, table[name]!) : "";
		if (!value) {
			throw new MountError({ type: "mount_unset", mount: name }, `mount ${name} has no default: supply it with --mount ${name}=<dir> or mounts.workflows.${workflow}.${name} in the local profile`);
		}
		if (!existsSync(value) || !statSync(value).isDirectory()) throw new MountError({ type: "mount_unset", mount: name }, `mount ${name}: ${value} is not a directory`);
		out[name] = { name, dir: value };
	}
	return out;
}

type HashCache = Record<string, string>;

function cachePath(): string {
	return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "wallis", "file-hashes.json");
}

function loadCache(): HashCache {
	try {
		return JSON.parse(readFileSync(cachePath(), "utf8")) as HashCache;
	} catch {
		return {};
	}
}

/**
 * sha256 over the sorted relative paths and content hashes of every file
 * in the dir. File hashes are reused while a file's path, mtime and size
 * are unchanged.
 */
export function mountDigest(dir: string): string {
	const cache = loadCache();
	let dirty = false;
	const lines: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const path = join(d, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) {
				const st = statSync(path, { bigint: true });
				const key = `${path}\0${st.mtimeNs}\0${st.size}`;
				let hash = cache[key];
				if (!hash) {
					hash = createHash("sha256").update(readFileSync(path)).digest("hex");
					cache[key] = hash;
					dirty = true;
				}
				lines.push(`${relative(dir, path)}\t${hash}`);
			}
		}
	};
	walk(dir);
	if (dirty) {
		try {
			mkdirSync(dirname(cachePath()), { recursive: true });
			writeFileSync(cachePath(), JSON.stringify(cache));
		} catch {
			// The cache only saves time; digests do not depend on it.
		}
	}
	return `mount:sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}
