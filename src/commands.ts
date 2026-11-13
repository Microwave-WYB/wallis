// One command call: its input mounted read-only (artifacts at
// /in/<hex>/<name>, Trees at /in/trees/<hex>), its argv from the command's
// `run`, the process in its sandbox with the input JSON on stdin, then its
// `parse` (default: stdout as JSON) and the output checked against the
// command's schema. Files the command wrote become artifacts or Trees by
// moving them into the store: nothing is copied, and the scratch dir is
// discarded (docs/v2.md §8: artifacts only).

import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { CommandFailure, Json } from "./host/core.ts";
import { removeWork } from "./host/layers.ts";
import { head, LAYOUT, runSpawn, type SandboxPlan, sandboxed } from "./host/sandbox.ts";
import type { Store } from "./host/store.ts";
import { lockVolumes } from "./host/volumes.ts";
import type { CommandDef, CommandResult } from "./nodes.ts";
import { declaredMedia, errorText, guessMedia, refsIn, schemaErrors, stripPaths, toJson, walkMarked, withPaths } from "./values.ts";

/** Where a ref is mounted inside a sandbox. */
export function mountPoint(r: { kind: "artifact" | "tree"; digest: string; name?: unknown }): string {
	const hex = r.digest.slice("sha256:".length);
	return r.kind === "artifact" ? `${LAYOUT.inputs}/${hex.slice(0, 16)}/${String(r.name)}` : `${LAYOUT.trees}/${hex.slice(0, 16)}`;
}

/** The mounts of every ref in a value. */
export function mountsOf(store: Store, value: unknown): { inputs: { at: string; file: string }[]; trees: { at: string; lowers: string[] }[] } {
	const inputs: { at: string; file: string }[] = [];
	const trees: { at: string; lowers: string[] }[] = [];
	for (const r of refsIn(value)) {
		if (r.kind === "artifact") {
			if (!store.hasBlob(r.digest)) throw new Error(`artifact ${String(r.name)} (${r.digest}) is not in the project's store`);
			inputs.push({ at: mountPoint(r), file: store.blobPath(r.digest) });
		} else {
			const layers = store.treeLayers(r.digest);
			if (layers === null) throw new Error(`Tree ${r.digest} is not in the project's store`);
			trees.push({ at: mountPoint(r), lowers: layers.map((l) => store.layerDir(l)) });
		}
	}
	return { inputs, trees };
}

class Draft {
	readonly kind: "file" | "dir";
	readonly name: string;
	constructor(kind: "file" | "dir", name: string) {
		this.kind = kind;
		this.name = name;
	}
}

export type CommandOutcome = { type: "returned"; output: Json } | { type: "failed"; failure: CommandFailure };

class Missing extends Error {}
class Leaves extends Error {}

export async function runCommand(call: { store: Store; work: string; def: CommandDef; input: Json; plan: () => SandboxPlan; signal: AbortSignal; onWait?: (volume: string | null) => void }): Promise<CommandOutcome> {
	const { store, def } = call;
	let plan: SandboxPlan;
	let mounts: ReturnType<typeof mountsOf>;
	let argv: readonly string[];
	const mounted = withPaths(call.input, mountPoint) as Json;
	try {
		plan = call.plan();
		mounts = mountsOf(store, call.input);
		argv = (def.run as (i: unknown) => readonly string[])(mounted);
		if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) throw new Error(`run returned ${JSON.stringify(argv)}, not a non-empty argv of strings`);
	} catch (error) {
		return { type: "failed", failure: { type: "unrunnable", error: error instanceof Error ? error.message : String(error) } };
	}
	const scratch = join(call.work, "w");
	removeWork(call.work);
	mkdirSync(scratch, { recursive: true });
	try {
		let locks: Awaited<ReturnType<typeof lockVolumes>>;
		try {
			locks = await lockVolumes(plan.volumes, { signal: call.signal, ...(call.onWait ? { onWait: call.onWait } : {}) });
		} catch (error) {
			if (call.signal.aborted) return { type: "failed", failure: { type: "killed", signal: "SIGKILL", stderr_head: "stopped by wallis while waiting for a volume" } };
			return { type: "failed", failure: { type: "unrunnable", error: error instanceof Error ? error.message : String(error) } };
		}
		let r: Awaited<ReturnType<typeof runSpawn>>;
		try {
			r = await runSpawn(sandboxed(plan, argv, { work: { kind: "dir", dir: scratch }, inputs: mounts.inputs, trees: mounts.trees }), JSON.stringify(mounted), { signal: call.signal });
		} finally {
			await locks.release();
		}
		if (r.setup !== null) return { type: "failed", failure: { type: "unrunnable", error: `the sandbox could not start the command: ${r.setup}` } };
		if (r.aborted) return { type: "failed", failure: { type: "killed", signal: "SIGKILL", stderr_head: "stopped by wallis" } };
		if (r.signal !== null) return { type: "failed", failure: { type: "killed", signal: r.signal, stderr_head: head(r.stderr) } };
		if (r.exit !== 0) return { type: "failed", failure: { type: "exit_code", code: r.exit, stderr_head: head(r.stderr || r.stdout) } };
		const result: CommandResult = {
			code: r.exit,
			stdout: r.stdout,
			stderr: r.stderr,
			file: (name: string) => new Draft("file", name) as never,
			dir: (name: string) => new Draft("dir", name) as never,
		};
		let parsed: unknown;
		try {
			parsed = def.parse ? (def.parse as (r: CommandResult, i: unknown) => unknown)(result, mounted) : JSON.parse(r.stdout);
		} catch (error) {
			return { type: "failed", failure: { type: "parse_error", message: error instanceof Error ? error.message : String(error) } };
		}
		let output: unknown;
		try {
			output = resolveDrafts(store, scratch, def.output, parsed);
		} catch (error) {
			if (error instanceof Missing) return { type: "failed", failure: { type: "missing_file", name: error.message } };
			if (error instanceof Leaves) return { type: "failed", failure: { type: "output_mismatch", errors: [error.message] } };
			throw error;
		}
		const json = toJson(output);
		if (!json.ok) return { type: "failed", failure: { type: "output_mismatch", errors: [json.error] } };
		const value = stripPaths(json.value);
		const errors = schemaErrors(def.output, value);
		if (errors.length > 0) return { type: "failed", failure: { type: "output_mismatch", errors: errorText(errors) } };
		return { type: "returned", output: value };
	} finally {
		removeWork(call.work);
	}
}

/**
 * `r.file` / `r.dir` drafts, into the store: media from the output schema where it declares one.
 * The whole path is resolved inside the scratch dir: anything that leads out of it (a symlink to
 * a host path) is refused, never read. A regular file the command owns, reached without a
 * symlink, is moved (no copy); anything else (a file reached through a symlink inside /w, a hard
 * link) is copied, so nothing outside the call's own files is ever moved.
 */
function resolveDrafts(store: Store, scratch: string, schema: unknown, value: unknown): unknown {
	const realScratch = realpathSync(scratch);
	// Every draft's path: one that another draft's path holds, or is held by, or names too, is copied
	// (moving it would take it from under the other: `r.file("out/a")` with `r.dir("out")`).
	const paths: string[] = [];
	const collect = (v: unknown): void => {
		if (v instanceof Draft) paths.push(resolve(scratch, v.name));
		else if (Array.isArray(v)) v.forEach(collect);
		else if (v !== null && typeof v === "object") Object.values(v).forEach(collect);
	};
	collect(value);
	const overlaps = (path: string) => paths.filter((p) => p === path || p.startsWith(`${path}${sep}`) || path.startsWith(`${p}${sep}`)).length > 1;
	const ingest = (d: Draft, media: string | undefined) => {
		const path = resolve(scratch, d.name);
		const rel = relative(scratch, path);
		if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) throw new Leaves(`${d.name} is not a path inside the command's scratch dir`);
		let real: string;
		try {
			real = realpathSync(path);
		} catch {
			throw new Missing(d.name);
		}
		if (real !== realScratch && !real.startsWith(`${realScratch}${sep}`)) throw new Leaves(`${d.name} leads to ${real}, which leaves the command's scratch dir: a result must be a file the command wrote in /w`);
		const direct = real === resolve(realScratch, rel) && !overlaps(path);
		const st = lstatSync(real);
		if (d.kind === "file") {
			if (!st.isFile()) throw new Missing(`${d.name} (not a regular file)`);
			const owned = direct && st.nlink === 1 && st.uid === process.getuid?.();
			return { kind: "artifact", digest: store.ingestFile(real, { move: owned }), name: basename(d.name), media: media ?? guessMedia(d.name) };
		}
		if (!st.isDirectory()) throw new Missing(`${d.name} (not a directory)`);
		return { kind: "tree", digest: store.snapshot(real, { move: direct }) };
	};
	const marked = walkMarked(schema, value, (mark, node, v) => (v instanceof Draft ? ingest(v, mark === "artifact" ? declaredMedia(node) : undefined) : v));
	const rest = (v: unknown): unknown => {
		if (v instanceof Draft) return ingest(v, undefined);
		if (Array.isArray(v)) return v.map(rest);
		if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rest(x)]));
		return v;
	};
	return rest(marked);
}
