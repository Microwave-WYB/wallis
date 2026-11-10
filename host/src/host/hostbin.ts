// Host programs wallis itself runs (bwrap, systemd-run): resolved once, by
// absolute path, from the host process's own PATH, and spawned with a
// minimal fixed environment. Nothing a workflow declares can choose which
// program runs on the host, or steer its loader.

import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const resolved = new Map<string, string>();

/** A host program's absolute real path, from the host's PATH when wallis started; the bare name if it is not found. */
export function hostProgram(name: string): string {
	let path = resolved.get(name);
	if (path === undefined) {
		path = name;
		for (const dir of (HOST_PATH ?? "").split(delimiter)) {
			if (!isAbsolute(dir)) continue;
			try {
				accessSync(join(dir, name), constants.X_OK);
				path = realpathSync(join(dir, name));
				break;
			} catch {
				// not here
			}
		}
		resolved.set(name, path);
	}
	return path;
}

/** The host's PATH as wallis found it, before anything else ran. */
const HOST_PATH = process.env.PATH;

/**
 * Why an environment variable may not be set in a sandbox, or null. `PATH`,
 * `HOME` and `WALLIS_*` are wallis's; `LD_*` steers the loader.
 */
export function sandboxEnvProblem(key: string): string | null {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return "not an environment variable name";
	if (key === "PATH" || key === "HOME") return "set by wallis";
	if (key.startsWith("WALLIS_")) return "wallis's own";
	if (key.startsWith("LD_")) return "steers the dynamic loader";
	return null;
}

/** Variables that steer the host programs (libc, the loader, systemd, D-Bus): never carried in a host-side spawn's environment. */
const HOST_STEERING = ["GCONV_PATH", "GLIBC_TUNABLES", "LOCPATH", "NLSPATH", "HOSTALIASES", "RES_OPTIONS", "LOCALDOMAIN", "TZDIR", "TMPDIR", "XDG_RUNTIME_DIR"];
const HOST_STEERING_PREFIXES = ["MALLOC_", "SYSTEMD_", "DBUS_", "BWRAP_"];

/**
 * Why a secret (carried in the environment of the host-side spawn, so it
 * never appears on a command line) may not have this name, or null.
 */
export function secretEnvProblem(key: string): string | null {
	const problem = sandboxEnvProblem(key);
	if (problem !== null) return problem;
	if (HOST_STEERING.includes(key) || HOST_STEERING_PREFIXES.some((p) => key.startsWith(p))) return "steers the host-side spawn";
	return null;
}

/** The environment of a host program wallis runs directly: the session bus systemd-run needs, nothing else. */
export function hostEnv(): Record<string, string> {
	return Object.fromEntries(["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
}
