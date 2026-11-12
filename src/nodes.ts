// Nodes and resources (docs/v2.md §4): plain values. Each carries its
// definition (behind a symbol, so the public types stay as `api.d.ts` has
// them), its digest (its identity: what it is, never its name) and its
// label (its const name and definition site, for people only).

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "typebox";
import { projectOf } from "./host/runs.ts";
import { type ArtifactRef, canonical, hasFiles, parseDuration, sha256, type TreeRef } from "./values.ts";

/** The key of a node's definition. */
export const DEF: unique symbol = Symbol("wallis.def");

// --- Definition sites -------------------------------------------------------------

const LIB = dirname(fileURLToPath(import.meta.url));

export interface Site {
	/** The const the node was assigned to ("default" for `export default`), or null. */
	readonly name: string | null;
	readonly file: string;
	readonly line: number;
	/** `stitch (film/workflow.ts:93)`. */
	readonly label: string;
}

/** Where the caller of a wallis builder is: the first stack frame outside this package, and the const it assigns to. */
export function definitionSite(fallback: string): Site {
	const stack = new Error().stack?.split("\n").slice(1) ?? [];
	for (const frame of stack) {
		const m = /\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?\s*$/.exec(frame);
		if (!m) continue;
		const file = m[1]!.startsWith("file://") ? fileURLToPath(m[1]!) : m[1]!;
		if (file.startsWith(`${LIB}/`)) continue;
		const line = Number(m[2]);
		let name: string | null = null;
		try {
			const text = readFileSync(file, "utf8").split("\n")[line - 1] ?? "";
			name = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/.exec(text)?.[1] ?? (/\bexport\s+default\b/.test(text) ? "default" : null);
		} catch {
			// a file we cannot read: no name
		}
		const shown = name ?? fallback;
		return { name, file, line, label: `${shown} (${relative(projectOf(file), file)}:${line})` };
	}
	return { name: null, file: "", line: 0, label: fallback };
}

// --- Sandboxes --------------------------------------------------------------------

export interface SandboxSpec {
	/** Programs that must exist; each is exposed with its prefix's lib/libexec/share only. */
	readonly requires?: readonly string[];
	/** `"<host>:<target>:ro"` read-only binds, or `"<name>:<target>"` named volumes. */
	readonly volumes?: readonly string[];
	readonly environment?: Readonly<Record<string, string>>;
	readonly devices?: readonly string[];
	/** All or nothing (bwrap). Default `"none"`. */
	readonly network?: "none" | "host";
}
export interface Sandbox extends SandboxSpec {
	readonly kind: "sandbox";
}

/** What the host needs of a sandbox: its spec and the dir its relative volumes resolve against. */
export interface SandboxDef {
	readonly spec: Required<SandboxSpec>;
	readonly dir: string;
	readonly digest: string;
}

export function sandboxDef(s: Sandbox): SandboxDef {
	return (s as unknown as { [DEF]: SandboxDef })[DEF];
}

export function sandbox(spec: SandboxSpec): Sandbox {
	// HOME is the call's workspace (/w) in every sandbox: an author's would silently not apply.
	if (spec.environment && "HOME" in spec.environment) throw new Error("sandbox environment.HOME: wallis sets HOME to /w, the call's workspace, in every sandbox; use another variable (an author's PATH is prepended to wallis's)");
	const site = definitionSite("sandbox");
	const full: Required<SandboxSpec> = { requires: [...(spec.requires ?? [])], volumes: [...(spec.volumes ?? [])], environment: { ...(spec.environment ?? {}) }, devices: [...(spec.devices ?? [])], network: spec.network ?? "none" };
	const def: SandboxDef = { spec: full, dir: site.file ? dirname(site.file) : process.cwd(), digest: sha256(canonical(full)) };
	return Object.freeze({ kind: "sandbox" as const, ...full, [DEF]: def });
}

/** The sandbox an agent workspace or tool gets when it declares none: the host base only. */
export const BASE_SANDBOX: SandboxDef = { spec: { requires: [], volumes: [], environment: {}, devices: [], network: "none" }, dir: process.cwd(), digest: sha256(canonical({ base: true })) };

// --- Tools ------------------------------------------------------------------------

/** A tool usable by agents (`tools`) and by bodies (`ctx.call`). */
export interface Tool<I = unknown, O = unknown> {
	readonly kind: "tool";
	__io?(i: I): O;
}

/**
 * A custom tool, as a toolset module exports it: a pi `AgentTool` plus wallis's
 * `outputSchema` (the typed result bodies get from `ctx.call`), MCP-style
 * `annotations`, and `replay: "safe"` for tools that may run again on resume.
 */
export interface WallisTool<P extends TSchema = TSchema, R extends TSchema = TSchema> {
	readonly name: string;
	readonly label?: string;
	readonly description: string;
	readonly parameters: P;
	readonly outputSchema?: R;
	readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly openWorldHint?: boolean };
	readonly replay?: "safe";
	execute(
		id: string,
		params: Static<P>,
		signal?: AbortSignal,
	): Promise<{ readonly content: readonly ({ readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string })[]; readonly details?: unknown; readonly structuredContent?: Static<R> }>;
}

export type ToolSourceDef =
	| { readonly kind: "toolset"; readonly file: string; readonly source: string; readonly sandbox: SandboxDef; readonly network: "none" | "host"; readonly secrets: readonly string[] }
	| { readonly kind: "mcp"; readonly server: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly sandbox: SandboxDef; readonly network: "none" | "host" };

/** One tool: its source and its name there (`null` for a whole MCP server). */
export interface ToolDef {
	readonly source: ToolSourceDef;
	readonly remote: string | null;
	readonly digest: string;
	readonly label: string;
}

export function toolDef(t: Tool<unknown, unknown>): ToolDef {
	return (t as unknown as { [DEF]: ToolDef })[DEF];
}

type ParamsOf<T> = T extends { readonly parameters: infer P extends TSchema } ? Static<P> : never;
type ResultOf<T> = T extends { readonly outputSchema: infer R extends TSchema } ? Static<R> : unknown;
export type Toolset<M> = { readonly [K in keyof M as M[K] extends { readonly execute: unknown; readonly parameters: unknown } ? K : never]: Tool<ParamsOf<M[K]>, ResultOf<M[K]>> };

function sourceDigest(s: ToolSourceDef): string {
	return s.kind === "toolset" ? sha256(canonical({ toolset: sha256(s.source), sandbox: s.sandbox.digest, network: s.network })) : sha256(canonical({ mcp: s.server, command: s.command, args: s.args, sandbox: s.sandbox.digest, network: s.network }));
}

function toolProxy(source: ToolSourceDef, label: string): Record<string, Tool> {
	const tools = new Map<string, Tool>();
	return new Proxy({} as Record<string, Tool>, {
		get(_t, key) {
			if (typeof key !== "string") return undefined;
			let tool = tools.get(key);
			if (!tool) {
				const def: ToolDef = { source, remote: key, digest: sha256(canonical({ source: sourceDigest(source), tool: key })), label: `${key} (${label})` };
				tool = Object.freeze({ kind: "tool" as const, [DEF]: def });
				tools.set(key, tool);
			}
			return tool;
		},
	});
}

/** Custom tools: a module of pi `AgentTool`s, run in its own sandboxed process. */
export function toolset<M>(path: string, options: { readonly sandbox?: Sandbox; readonly network?: "none" | "host"; readonly secrets?: readonly string[] } = {}): Toolset<M> {
	const site = definitionSite("toolset");
	const file = resolve(site.file ? dirname(site.file) : process.cwd(), path);
	const box = options.sandbox ? sandboxDef(options.sandbox) : BASE_SANDBOX;
	const source: ToolSourceDef = { kind: "toolset", file, source: readFileSync(file, "utf8"), sandbox: box, network: options.network ?? box.spec.network, secrets: [...(options.secrets ?? [])] };
	return toolProxy(source, site.label) as unknown as Toolset<M>;
}

export interface McpConfig {
	readonly mcpServers: Readonly<Record<string, { readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }>>;
}
export type McpServers<J extends McpConfig> = { readonly [S in keyof J["mcpServers"]]: Tool & { readonly [tool: string]: Tool } };

/** Existing MCP servers as tools; `overlay` sets their sandbox and network per server. */
export function mcp<const J extends McpConfig>(config: J, overlay: { readonly [S in keyof J["mcpServers"]]?: { readonly sandbox?: Sandbox; readonly network?: "none" | "host" } } = {}): McpServers<J> {
	const site = definitionSite("mcp");
	const out: Record<string, unknown> = {};
	for (const [server, c] of Object.entries(config.mcpServers)) {
		const o = (overlay as Record<string, { sandbox?: Sandbox; network?: "none" | "host" } | undefined>)[server] ?? {};
		const box = o.sandbox ? sandboxDef(o.sandbox) : BASE_SANDBOX;
		const source: ToolSourceDef = { kind: "mcp", server, command: c.command, args: [...(c.args ?? [])], env: { ...(c.env ?? {}) }, sandbox: box, network: o.network ?? box.spec.network };
		const tools = toolProxy(source, site.label);
		const whole: ToolDef = { source, remote: null, digest: sha256(canonical({ source: sourceDigest(source) })), label: `${server} (${site.label})` };
		out[server] = new Proxy(Object.freeze({ kind: "tool" as const, [DEF]: whole }), {
			get(target, key) {
				if (key === "kind" || key === DEF) return (target as Record<string | symbol, unknown>)[key];
				return typeof key === "string" ? tools[key] : undefined;
			},
		});
	}
	return out as McpServers<J>;
}

// --- Commands ---------------------------------------------------------------------

export interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** A file the command wrote in its scratch dir, as an artifact (media from the output schema). */
	file<M extends string = any>(name: string): ArtifactRef<M>;
	/** A directory the command wrote in its scratch dir, as a Tree. */
	dir(name: string): TreeRef;
}

export interface Command<I = unknown, O = unknown> {
	readonly kind: "command";
	__io?(i: I): O;
}

export interface CommandDef {
	readonly sandbox: SandboxDef;
	readonly input: TSchema;
	readonly output: TSchema;
	readonly run: (input: never) => readonly string[];
	readonly parse: ((result: CommandResult, input: never) => unknown) | null;
	readonly digest: string;
	readonly label: string;
}

export function commandDef(c: Command<unknown, unknown>): CommandDef {
	return (c as unknown as { [DEF]: CommandDef })[DEF];
}

export function command<IS extends TSchema, OS extends TSchema>(def: {
	readonly sandbox: Sandbox;
	readonly input: IS;
	readonly output: OS;
	/** argv. Artifact and Tree refs in the input are mounted; their `path` is valid here. */
	readonly run: (input: Static<IS>) => readonly string[];
	/** Default: stdout parsed as JSON against `output`. */
	readonly parse?: (result: CommandResult, input: Static<IS>) => Static<OS>;
}): Command<Static<IS>, Static<OS>> {
	const site = definitionSite("command");
	const box = sandboxDef(def.sandbox);
	const digest = sha256(canonical({ kind: "command", sandbox: box.digest, input: def.input, output: def.output, run: def.run.toString(), parse: def.parse?.toString() ?? null }));
	const d: CommandDef = { sandbox: box, input: def.input, output: def.output, run: def.run as CommandDef["run"], parse: (def.parse ?? null) as CommandDef["parse"], digest, label: site.label };
	return Object.freeze({ kind: "command" as const, [DEF]: d });
}

// --- Agents -----------------------------------------------------------------------

export interface Agent<I = unknown, O = unknown, M = never> {
	readonly kind: "agent";
	readonly input: TSchema;
	readonly output: TSchema;
	__io?(i: I, m: M): O;
}

export interface AgentDef {
	readonly model: string;
	readonly prompt: string;
	readonly input: TSchema;
	readonly output: TSchema;
	readonly mailbox: TSchema | null;
	readonly tools: readonly ToolDef[];
	readonly workspace: { readonly access: "read" | "write" | "exec"; readonly sandbox: SandboxDef; readonly bashTimeoutMs: number } | null;
	readonly turns: number;
	readonly digest: string;
	readonly label: string;
}

export function agentDef(a: Agent<unknown, unknown, unknown>): AgentDef {
	return (a as unknown as { [DEF]: AgentDef })[DEF];
}

/** Workspace access as declared, else inferred: Artifact or Tree inputs give read, outputs give write; exec never. */
function access(input: TSchema, output: TSchema): "read" | "write" | null {
	if (hasFiles(output)) return "write";
	if (hasFiles(input)) return "read";
	return null;
}

export function agent<IS extends TSchema, OS extends TSchema, MS extends TSchema = never>(
	def: {
		/** An alias from project configuration. */
		readonly model: string;
		readonly prompt: string;
		readonly input: IS;
		readonly output: OS;
		/** Messages to a running call enter its next turn. Without it the agent has no address. */
		readonly mailbox?: MS;
		/** Custom and MCP tools. File tools come from `workspace.access`, never from here. */
		readonly tools?: readonly Tool<any, any>[];
		/**
		 * Default: inferred from the signature (Artifact/Tree inputs: read; outputs: write). `exec` is never
		 * inferred. `bashTimeout` (default "10m") kills a `bash` tool command that runs longer.
		 */
		readonly workspace?: { readonly access: "read" | "write" | "exec"; readonly sandbox?: Sandbox; readonly bashTimeout?: `${number}${"s" | "m" | "h"}` };
		/** The turn budget of one call. Default 30. Mailbox deliveries count. */
		readonly turns?: number;
	},
): Agent<Static<IS>, Static<OS>, [MS] extends [never] ? never : Static<MS>> {
	const site = definitionSite("agent");
	const tools = (def.tools ?? []).map((t) => toolDef(t));
	const declared = def.workspace;
	const inferred = declared ? declared.access : access(def.input, def.output);
	const workspace = inferred === null ? null : { access: inferred, sandbox: declared?.sandbox ? sandboxDef(declared.sandbox) : BASE_SANDBOX, bashTimeoutMs: parseDuration(declared?.bashTimeout ?? "10m") };
	const turns = def.turns ?? 30;
	const digest = sha256(
		canonical({ kind: "agent", model: def.model, prompt: def.prompt, input: def.input, output: def.output, mailbox: def.mailbox ?? null, tools: tools.map((t) => t.digest), workspace: workspace ? { access: workspace.access, sandbox: workspace.sandbox.digest, bash_timeout_ms: workspace.bashTimeoutMs } : null, turns }),
	);
	const d: AgentDef = { model: def.model, prompt: def.prompt, input: def.input, output: def.output, mailbox: def.mailbox ?? null, tools, workspace, turns, digest, label: site.label };
	return Object.freeze({ kind: "agent" as const, input: def.input, output: def.output, [DEF]: d });
}

/** An immutable agent session. Calling it returns the output and the next session; calling it twice branches. */
export interface Session<I = unknown, O = unknown, M = never> {
	readonly kind: "session";
	__io?(i: I, m: M): O;
}

/** A session as data: the agent it belongs to, its id (null: new), and its workspace's layers. */
export interface SessionData {
	readonly kind: "session";
	readonly agent: string;
	readonly id: string | null;
	readonly layers: readonly string[];
}

/** A session value: plain data, plus (in the body) the agent it calls. */
export function sessionValue(agent: AgentDef, id: string | null, layers: readonly string[]): SessionData {
	return Object.freeze({ kind: "session" as const, agent: agent.digest, id, layers: [...layers], [DEF]: agent });
}

export function sessionAgent(s: Session<unknown, unknown, unknown>): AgentDef | undefined {
	return (s as unknown as { [DEF]?: AgentDef })[DEF];
}

// --- Workflows ---------------------------------------------------------------------

export interface WorkflowDef {
	readonly input: TSchema;
	readonly output: TSchema;
	readonly mailbox: TSchema | null;
	readonly run: (ctx: never, input: never, mailbox: never) => Promise<unknown>;
	readonly digest: string;
	readonly site: Site;
	readonly label: string;
}

export function workflowDef(w: { readonly kind: "workflow" }): WorkflowDef {
	return (w as unknown as { [DEF]: WorkflowDef })[DEF];
}

export function isNode(v: unknown, kind: string): boolean {
	return v !== null && typeof v === "object" && (v as { kind?: unknown }).kind === kind && DEF in (v as object);
}
