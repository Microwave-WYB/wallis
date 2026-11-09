// Tool sources: custom tool modules (toolsets) and existing MCP servers.
// Both are reached the same way, as MCP over stdio through pi-mcp.
//
// - A toolset is bundled with esbuild together with the runner
//   (toolset-runner.ts) and run under node in the toolset's sandbox, with
//   the network it declares (default full) and only its named secrets in
//   its environment.
// - An MCP server from mcp.json runs in its overlay sandbox, with the
//   overlay's network; `${VAR}` secrets reach its environment only. It
//   never sees an agent's input artifacts or scratch dir, and wallis offers
//   no MCP `roots`: tools that expect local file paths cannot work on agent
//   files.
// - Every connection gets its own scratch dir, its working directory, so
//   nothing a server keeps on disk crosses agent calls.
// - Without bubblewrap a local source is refused (`sandbox_unavailable`);
//   it runs unconfined only when confinement is explicitly off.
//
// The client declares no capabilities, so servers cannot ask for sampling or
// elicitation; resources and prompts are ignored.
//
// Listing turns each source's tools into `ToolInfo`s. An agent's tool
// values resolve against them: a whole MCP server gives only its tools
// annotated `readOnlyHint: true` (the others are named in a warning), and
// every tool that may write outside gives a warning (not a refusal).
// Unannotated tools count as writes, per MCP's defaults.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { build } from "esbuild";
import type { Json, ToolAnnotations, ToolDesc } from "../sdk/index.ts";
import type { Declarations } from "../sdk/runtime.ts";
import { LAYOUT, SandboxError, type Sandboxes } from "./confine.ts";

const here = dirname(fileURLToPath(import.meta.url));
const nodeModules = resolve(here, "../../node_modules");

export type Source = { readonly kind: "toolset"; readonly path: string } | { readonly kind: "mcp"; readonly server: string };

export const sourceKey = (s: Source): string => (s.kind === "toolset" ? `toolset:${s.path}` : `mcp:${s.server}`);

/** One listed tool. `id` names it in requests and journals; `name` is what an agent sees. */
export interface ToolInfo {
	readonly id: string;
	readonly name: string;
	readonly source: Source;
	/** The tool's name on its server. */
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

type Listed = { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: ToolAnnotations; _meta?: Record<string, unknown> };

export function toolInfos(source: Source, listed: readonly Listed[]): ToolInfo[] {
	return listed.map((t) => {
		const annotations = t.annotations ?? {};
		// A toolset tool is served under its export name; the name its agent sees is in `_meta`.
		const shown = t._meta?.["wallis/name"];
		return source.kind === "toolset"
			? {
					id: `custom:${source.path}#${t.name}`,
					name: typeof shown === "string" ? shown : t.name,
					source,
					remote: t.name,
					description: t.description ?? t.name,
					inputSchema: (t.inputSchema ?? { type: "object" }) as Json,
					outputSchema: (t.outputSchema ?? null) as Json | null,
					annotations,
					replay: t._meta?.["wallis/replay"] === "safe" ? "safe" : "never",
				}
			: {
					id: `mcp:${source.server}/${t.name}`,
					name: `mcp__${source.server}__${t.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
					source,
					remote: t.name,
					description: t.description ?? t.name,
					inputSchema: (t.inputSchema ?? { type: "object" }) as Json,
					outputSchema: (t.outputSchema ?? null) as Json | null,
					annotations,
					replay: annotations.readOnlyHint === true ? "safe" : "never",
				};
	});
}

/** What wallis gives agents itself: no custom or MCP tool may take these names. */
export const BUILT_IN_TOOLS: ReadonlySet<string> = new Set(["codemode", "submit_result", "read_spill", "ask", "read", "write", "edit", "ls", "bash", "export_artifact"]);

/**
 * An agent's tool values against the listed tools: the tools it gets,
 * warnings, the first unknown tool, and the first name that is taken (a
 * built-in's, or another of its tools').
 */
export function resolveAgentTools(
	agent: string,
	descs: readonly ToolDesc[],
	listing: ReadonlyMap<string, readonly ToolInfo[]>,
): { tools: ToolInfo[]; warnings: string[]; unknown: string | null; taken: string | null } {
	const tools: ToolInfo[] = [];
	const warnings: string[] = [];
	let unknown: string | null = null;
	for (const d of descs) {
		if (d.kind === "ask") continue;
		const listed = listing.get(sourceKey(d.kind === "custom" ? { kind: "toolset", path: d.toolset } : { kind: "mcp", server: d.server })) ?? [];
		if (d.kind === "mcp_server") {
			const excluded = listed.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.remote);
			if (excluded.length > 0) warnings.push(`agent ${agent}: from MCP server ${d.server} only tools annotated readOnlyHint are given; excluded: ${excluded.join(", ")}`);
			tools.push(...listed.filter((t) => t.annotations.readOnlyHint === true));
			continue;
		}
		const id = d.kind === "custom" ? `custom:${d.toolset}#${d.export}` : `mcp:${d.server}/${d.tool}`;
		const found = listed.find((t) => t.id === id);
		if (found) tools.push(found);
		else unknown ??= id;
	}
	const seen = new Map<string, string>();
	let taken: string | null = null;
	for (const t of tools) {
		const prior = seen.get(t.name);
		if (BUILT_IN_TOOLS.has(t.name) || (prior !== undefined && prior !== t.id)) taken ??= t.name;
		seen.set(t.name, t.id);
	}
	for (const t of tools) {
		if (writesOutside(t.annotations)) {
			warnings.push(`agent ${agent}: tool ${t.name} may write outside (${t.annotations.readOnlyHint === undefined ? "unannotated" : JSON.stringify(t.annotations)}); outward writes belong in the workflow body`);
		}
	}
	return { tools, warnings, unknown, taken };
}

type ServerConfig = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };

function resolveSecrets(env: Readonly<Record<string, string>> | undefined, secrets: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (_m, name: string) => secrets[name] ?? "")]));
}

/** How local sources run: in their sandboxes, unconfined because confinement is off, or not at all. */
export type Confinement = { readonly type: "bwrap"; readonly boxes: Sandboxes } | { readonly type: "off" } | { readonly type: "unavailable" };

/** Connects to tool sources: a new connection each time (an agent call, or the run's body). */
export class ToolSources {
	readonly #decl: Declarations;
	readonly #workflowDir: string;
	readonly #runDir: string;
	readonly #confinement: Confinement;
	readonly #env: Readonly<Record<string, string | undefined>>;
	readonly #bundles = new Map<string, Promise<string>>();

	constructor(options: { decl: Declarations; workflowDir: string; runDir: string; confinement: Confinement; env?: Readonly<Record<string, string | undefined>> }) {
		this.#decl = options.decl;
		this.#workflowDir = options.workflowDir;
		this.#runDir = options.runDir;
		this.#confinement = options.confinement;
		this.#env = options.env ?? process.env;
	}

	/** Every source the workflow declares. */
	sources(): Source[] {
		const servers = Object.keys((this.#decl.mcp as { mcpServers?: object } | null)?.mcpServers ?? {});
		return [...Object.keys(this.#decl.toolsets).map((path): Source => ({ kind: "toolset", path })), ...servers.map((server): Source => ({ kind: "mcp", server }))];
	}

	async connect(source: Source): Promise<McpClient> {
		const transport = source.kind === "toolset" ? await this.#toolsetTransport(source.path) : this.#serverTransport(source.server);
		const client = new McpClient({ name: "wallis", version: "0.0.0" });
		await client.connect(transport);
		return client;
	}

	/** Every tool of every declared source, by source key. */
	async listAll(): Promise<Map<string, ToolInfo[]>> {
		const listing = new Map<string, ToolInfo[]>();
		for (const source of this.sources()) {
			const client = await this.connect(source);
			try {
				listing.set(sourceKey(source), toolInfos(source, (await client.listTools()) as Listed[]));
			} finally {
				await client.close();
			}
		}
		return listing;
	}

	#serverTransport(server: string) {
		const config = ((this.#decl.mcp as { mcpServers?: Record<string, ServerConfig> } | null)?.mcpServers ?? {})[server];
		if (!config) throw new Error(`no MCP server ${server}`);
		if (config.url) return new StreamableHttpTransport({ url: config.url, headers: resolveSecrets(config.headers, this.#env) });
		const env = resolveSecrets(config.env, this.#env);
		const argv = [config.command!, ...(config.args ?? [])];
		const overlay = this.#decl.mcpServers[server];
		const c = this.#confinement;
		if (c.type === "unavailable") throw new SandboxError({ type: "sandbox_unavailable", source: sourceKey({ kind: "mcp", server }) });
		// Each connection gets its own scratch dir: server state never crosses agent calls.
		const scratch = this.#scratch(`mcp-${server.replace(/[^A-Za-z0-9._-]/g, "_")}`);
		let sp: { command: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd?: string };
		if (c.type === "bwrap") {
			if (!overlay?.sandbox) throw new Error(`MCP server ${server} has no sandbox in the workflow's mcp overlay`);
			sp = c.boxes.spawn(overlay.sandbox, argv, { scratch, inputs: null }, { env, network: overlay.network });
		} else sp = { command: argv[0]!, args: argv.slice(1), env: { PATH: process.env.PATH ?? "", ...env }, cwd: scratch };
		return new StdioTransport({ command: sp.command, args: [...sp.args], env: { ...sp.env }, inheritEnv: false, stderr: "pipe", ...(sp.cwd ? { cwd: sp.cwd } : {}) });
	}

	async #toolsetTransport(path: string) {
		const decl = this.#decl.toolsets[path];
		if (!decl) throw new Error(`no toolset ${path}`);
		const c = this.#confinement;
		if (c.type === "unavailable") throw new SandboxError({ type: "sandbox_unavailable", source: sourceKey({ kind: "toolset", path }) });
		const dir = await this.#bundle(path);
		const secrets = Object.fromEntries(decl.secrets.flatMap((name) => (this.#env[name] === undefined ? [] : [[name, this.#env[name]!]])));
		const scratch = this.#scratch(`toolset-${digest(path).slice(0, 12)}`);
		let sp: { command: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd?: string };
		if (c.type === "bwrap") sp = c.boxes.spawn(decl.sandbox, ["node", `${LAYOUT.inputs}/runner.mjs`], { scratch, inputs: dir }, { env: secrets, network: decl.network });
		else sp = { command: process.execPath, args: [join(dir, "runner.mjs")], env: { PATH: process.env.PATH ?? "", ...secrets }, cwd: scratch };
		return new StdioTransport({ command: sp.command, args: [...sp.args], env: { ...sp.env }, inheritEnv: false, stderr: "pipe", ...(sp.cwd ? { cwd: sp.cwd } : {}) });
	}

	/** A fresh scratch dir for one connection: `work/<prefix>-<random>`. */
	#scratch(prefix: string): string {
		mkdirSync(join(this.#runDir, "work"), { recursive: true });
		return mkdtempSync(join(this.#runDir, "work", `${prefix}-`));
	}

	/** The module and the runner in one file, once per session: `<run>/toolsets/<digest>/runner.mjs`. */
	#bundle(path: string): Promise<string> {
		let bundled = this.#bundles.get(path);
		if (!bundled) {
			bundled = (async () => {
				const file = resolve(this.#workflowDir, path);
				const runner = resolve(here, "toolset-runner.ts");
				const result = await build({
					stdin: { contents: `import * as m from ${JSON.stringify(file)};\nimport { serve } from ${JSON.stringify(runner)};\nawait serve(m);\n`, resolveDir: dirname(file), loader: "ts", sourcefile: "wallis-toolset.ts" },
					bundle: true,
					write: false,
					format: "esm",
					platform: "node",
					target: "node22",
					alias: { wallis: resolve(here, "../sdk/index.ts") },
					nodePaths: [nodeModules],
					banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
					legalComments: "none",
					logLevel: "silent",
				});
				const code = result.outputFiles[0]!.text;
				const dir = join(this.#runDir, "toolsets", digest(code).slice(0, 16));
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "runner.mjs"), code);
				return dir;
			})();
			this.#bundles.set(path, bundled);
		}
		return bundled;
	}
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
