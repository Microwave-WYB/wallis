// Tool sources (docs/v2.md §4.1): custom tool modules (toolsets) and
// existing MCP servers, both reached as MCP over stdio through pi-mcp.
//
// - A toolset is bundled with esbuild together with the runner
//   (toolset-runner.ts) into one file, a blob in the project store. A tool's
//   identity is (bundle digest, export key), never the module's path or
//   name. The bundle runs under `node` in the toolset's sandbox, bound
//   read-only at /in/runner.mjs, with only its named secrets in its
//   environment.
// - An MCP server runs its command in its overlay's sandbox; `${VAR}` in
//   its `env` is filled from the caller's environment.
// - Every connection gets its own scratch dir as `/w`, so nothing a source
//   keeps on disk crosses calls (named volumes are where state persists).
//
// The client declares no capabilities, so servers cannot ask for sampling
// or elicitation; resources and prompts are ignored.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { build } from "esbuild";
import type { Json } from "./core.ts";
import { removeWork } from "./layers.ts";
import { LAYOUT, type SandboxPlan, sandboxed } from "./sandbox.ts";
import { lockVolumes, type VolumeLocks } from "./volumes.ts";
import type { Store } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** `.ts` from source, `.js` from the built package (dist/). */
const ext = extname(fileURLToPath(import.meta.url));
const nodeModules = resolve(here, "../../node_modules");

/** MCP tool annotations (hints; unannotated counts as writing, per MCP's defaults). */
export interface ToolAnnotations {
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly idempotentHint?: boolean;
	readonly openWorldHint?: boolean;
}

/** Where a tool comes from: a bundled toolset (by digest) or an MCP server (by name in its config). */
export type Source = { readonly kind: "toolset"; readonly bundle: string } | { readonly kind: "mcp"; readonly server: string };

/** One listed tool. `id` is its identity; `name` is what an agent sees. */
export interface ToolInfo {
	readonly id: string;
	readonly name: string;
	readonly source: Source;
	/** The tool's name on its server (a toolset's export key). */
	readonly remote: string;
	readonly description: string;
	readonly inputSchema: Json;
	readonly outputSchema: Json | null;
	readonly annotations: ToolAnnotations;
	/** Safe to make again when it was in flight at a crash: `replay: "safe"`, or an MCP tool annotated read-only. */
	readonly replay: "safe" | "never";
}

/** May write outside: destructive, or not read-only and open-world (unannotated: MCP's defaults, so yes). */
export function writesOutside(a: ToolAnnotations): boolean {
	return a.readOnlyHint !== true && (a.destructiveHint !== false || a.openWorldHint !== false);
}

/** A tool's identity: (bundle digest, export key) or (server, tool). */
export function toolId(source: Source, remote: string): string {
	return source.kind === "toolset" ? `toolset:${source.bundle}#${remote}` : `mcp:${source.server}/${remote}`;
}

type Listed = { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: ToolAnnotations; _meta?: Record<string, unknown> };

/** A source's listing as tool infos. Boundary values: each field is checked, never cast. */
export function toolInfos(source: Source, listed: readonly unknown[]): ToolInfo[] {
	return listed.flatMap((raw): ToolInfo[] => {
		if (raw === null || typeof raw !== "object" || typeof (raw as { name?: unknown }).name !== "string") return [];
		const t = raw as Listed;
		const annotations = t.annotations !== null && typeof t.annotations === "object" ? t.annotations : {};
		const shown = t._meta?.["wallis/name"];
		const json = (v: unknown): Json | null => (v !== null && typeof v === "object" ? (JSON.parse(JSON.stringify(v)) as Json) : null);
		const common = {
			id: toolId(source, t.name),
			source,
			remote: t.name,
			description: typeof t.description === "string" ? t.description : t.name,
			inputSchema: json(t.inputSchema) ?? { type: "object" },
			outputSchema: json(t.outputSchema),
			annotations,
		};
		return [
			source.kind === "toolset"
				? { ...common, name: typeof shown === "string" ? shown : t.name, replay: t._meta?.["wallis/replay"] === "safe" ? "safe" : "never" }
				: { ...common, name: `mcp__${source.server}__${t.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64), replay: annotations.readOnlyHint === true ? "safe" : "never" },
		];
	});
}

/**
 * Bundles a toolset module with the runner into one file, stored as a blob.
 * Returns the bundle's digest: the toolset's identity for this run.
 */
export async function bundleToolset(store: Store, file: string): Promise<string> {
	const runner = resolve(here, `toolset-runner${ext}`);
	const result = await build({
		stdin: { contents: `import * as m from ${JSON.stringify(resolve(file))};\nimport { serve } from ${JSON.stringify(runner)};\nawait serve(m);\n`, resolveDir: dirname(resolve(file)), loader: "ts", sourcefile: "wallis-toolset.ts" },
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		target: "node22",
		alias: { wallis: resolve(here, `toolset-shim${ext}`) },
		nodePaths: [nodeModules],
		banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
		legalComments: "none",
		logLevel: "silent",
	});
	return store.putText(result.outputFiles[0]!.text);
}

export interface McpServerConfig {
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

/** `${VAR}` in a server's env, from the caller's environment (missing: empty). */
export function fillSecrets(env: Readonly<Record<string, string>> | undefined, from: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (_m, name: string) => from[name] ?? "")]));
}

/** A connected source: closing it ends its process and removes its scratch dir. */
export interface Opened {
	readonly client: McpClient;
	close(): Promise<void>;
}

/** Connections to tool sources: a new process and scratch dir each time. */
export class ToolSources {
	readonly #store: Store;
	readonly #work: string;

	/** `work`: where connections' scratch dirs go (the run's `work/`). */
	constructor(store: Store, work: string) {
		this.#store = store;
		this.#work = work;
	}

	#scratch(prefix: string): string {
		mkdirSync(this.#work, { recursive: true });
		return mkdtempSync(join(this.#work, `${prefix}-`));
	}

	/** A bundled toolset under `node` in its sandbox (whose plan provides `node`), with only `secrets` in its environment. */
	async connectToolset(bundle: string, plan: SandboxPlan, secrets: Readonly<Record<string, string>> = {}): Promise<Opened> {
		if (!this.#store.hasBlob(bundle)) throw new Error(`toolset bundle ${bundle} is not in the store`);
		if (plan.programs.node === undefined) throw new Error("a toolset's sandbox must require node");
		const dir = this.#scratch(`toolset-${bundle.slice(7, 19)}`);
		const sp = sandboxed(plan, ["node", `${LAYOUT.inputs}/runner.mjs`], { work: { kind: "dir", dir }, inputs: [{ at: `${LAYOUT.inputs}/runner.mjs`, file: this.#store.blobPath(bundle) }], trees: [], env: secrets });
		return this.#connect(sp, dir, `toolset ${bundle.slice(0, 19)}`, plan);
	}

	/** An MCP server's command in its sandbox, with its env's secrets filled from `from`. */
	async connectServer(config: McpServerConfig, plan: SandboxPlan, from: Readonly<Record<string, string | undefined>> = process.env): Promise<Opened> {
		const dir = this.#scratch("mcp");
		const sp = sandboxed(plan, [config.command, ...(config.args ?? [])], { work: { kind: "dir", dir }, inputs: [], trees: [], env: fillSecrets(config.env, from) });
		return this.#connect(sp, dir, `MCP server ${config.command}`, plan);
	}

	/** A failed start names the source and keeps the process's stderr: the cause is usually there. */
	async #connect(sp: { command: string; args: readonly string[]; cwd: string }, dir: string, what: string, plan: SandboxPlan): Promise<Opened> {
		// Its named volumes are held as long as the connection is open: shared for :ro, exclusive otherwise.
		let locks: VolumeLocks;
		try {
			locks = await lockVolumes(plan.volumes);
		} catch (e) {
			removeWork(dir);
			throw e;
		}
		const transport = new StdioTransport({ command: sp.command, args: [...sp.args], env: {}, inheritEnv: false, stderr: "pipe", cwd: sp.cwd });
		const client = new McpClient({ name: "wallis", version: "2.0.0" });
		try {
			await client.connect(transport);
		} catch (e) {
			// Give a dying process a moment to finish writing its stderr.
			await new Promise((r) => setTimeout(r, 100));
			const stderr = transport.stderr.trim().split("\n").slice(-20).join("\n");
			await client.close().catch(() => {});
			removeWork(dir);
			await locks.release();
			throw new Error(`${what} did not start: ${e instanceof Error ? e.message : String(e)}${stderr ? `\nits stderr:\n${stderr}` : " (it wrote nothing to stderr)"}`, { cause: e });
		}
		return {
			client,
			close: async () => {
				try {
					await client.close();
				} finally {
					removeWork(dir);
					await locks.release();
				}
			},
		};
	}

	/** Every tool of a source. */
	static async list(client: McpClient, source: Source): Promise<ToolInfo[]> {
		return toolInfos(source, (await client.listTools()) as unknown[]);
	}
}

export const digestText = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
