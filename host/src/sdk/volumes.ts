// Sandbox volumes, in Docker/compose vocabulary (runs inside QuickJS: no
// Node imports).
//
//   "<host path>:<container target>:ro"  a bind volume: a host dir, read-only.
//                                         The mode must be written, and only
//                                         `ro` exists. The host path is
//                                         relative (to the workflow dir) or
//                                         starts with `~/`.
//   "<name>:<container target>"          a named volume: a wallis-managed,
//                                         writable cache dir shared across
//                                         runs (results must not depend on it).
//
// The same rules are a type (a wrong volume is a compile error with a
// readable message) and a parse (`parseVolume`), so a volume that slips past
// the types is refused at preflight, typed, never dropped.

/** A volume, parsed. `invalid` keeps the text and why, for a typed refusal. */
export type Volume =
	| { readonly kind: "bind"; readonly host: string; readonly target: string }
	| { readonly kind: "named"; readonly name: string; readonly target: string }
	| { readonly kind: "invalid"; readonly text: string; readonly reason: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A host path a bind may name: relative, or under the home dir. */
const hostPath = (h: string) => h.startsWith("./") || h.startsWith("../") || h.startsWith("~/");

export function parseVolume(text: string): Volume {
	const parts = text.split(":");
	const invalid = (reason: string): Volume => ({ kind: "invalid", text, reason });
	if (parts.length === 3) {
		const [host, target, mode] = parts as [string, string, string];
		if (mode !== "ro") return invalid(`mode ${mode}: only :ro exists (a volume is never writable; write user dirs with wallis export)`);
		if (!hostPath(host)) return invalid("a bind's host path is relative (./ or ../) or starts with ~/");
		if (!target.startsWith("/")) return invalid("the container target must be absolute");
		return { kind: "bind", host, target };
	}
	if (parts.length === 2) {
		const [source, target] = parts as [string, string];
		if (hostPath(source) || source.startsWith("/")) return invalid("a bind volume needs its mode: <host path>:<target>:ro");
		if (!NAME.test(source)) return invalid("a named volume's name is letters, digits, _ . -");
		if (!target.startsWith("/")) return invalid("the container target must be absolute");
		return { kind: "named", name: source, target };
	}
	return invalid("a volume is <host path>:<target>:ro or <name>:<target>");
}

type HostPath = `./${string}` | `../${string}` | `~/${string}`;

/** Dirs the bwrap backend owns (host/src/host/volumes.ts refuses the same at preflight). */
type Reserved = "/usr" | "/etc" | "/bin" | "/sbin" | "/lib" | "/lib32" | "/lib64" | "/libx32" | "/proc" | "/dev" | "/in" | "/w" | "/tmp" | "/run/wallis";

/** A target as the types check it: absolute, and neither at, under nor above a reserved dir. */
type Target<T extends string, V extends string> = T extends `/${string}`
	? T extends Reserved | `${Reserved}/${string}` | "/" | "/run"
		? "error: the target overlaps a dir the bwrap backend owns (/usr /etc /bin /sbin /lib* /proc /dev /in /w /tmp /run/wallis)"
		: V
	: "error: the container target must be absolute";

/** A volume string as the types check it: itself, or a readable error. */
export type CheckVolume<V extends string> = V extends `${infer H}:${infer T}:${infer M}`
	? M extends "ro"
		? H extends HostPath
			? Target<T, V>
			: "error: a bind's host path is relative (./ or ../) or starts with ~/"
		: `error: mode :${M}: only :ro exists (a volume is never writable)`
	: V extends `${infer N}:${infer T}`
		? N extends HostPath | `/${string}`
			? "error: a bind volume needs its mode: <host path>:<target>:ro"
			: Target<T, V>
		: "error: a volume is <host path>:<target>:ro or <name>:<target>";

/** A device as the types check it: a plain path under /dev, not a shared-state dir (the host checks it is a device). */
export type CheckDevice<D extends string> = D extends `/dev/${infer R}`
	? D extends `${string}/./${string}` | `${string}/../${string}` | `${string}/.` | `${string}/..` | `${string}//${string}` | `${string}/`
		? "error: a device is a plain path under /dev"
		: R extends "shm" | "pts" | "mqueue" | "fd" | `${"shm" | "pts" | "mqueue" | "fd"}/${string}`
			? "error: shared state, not a device"
			: D
	: "error: a device is a plain path under /dev";

/** Each device of a list, checked. */
export type CheckDevices<D extends readonly string[]> = { readonly [K in keyof D]: CheckDevice<D[K]> };

/** Each volume of a list, checked. */
export type CheckVolumes<V extends readonly string[]> = { readonly [K in keyof V]: CheckVolume<V[K]> };
