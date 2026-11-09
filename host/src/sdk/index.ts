// The wallis SDK: declarations a workflow.ts is written with.
//
// Everything here is plain data plus the workflow body. It runs inside the
// QuickJS sandbox (no fs, no network, virtual clock, seeded randomness), so
// it must not import Node modules.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import Type, { type Static, type TSchema } from "typebox";

export { Type };
export type { Static, TSchema };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// --- Models ------------------------------------------------------------------

/** Alias table. Values are pi model strings (`provider/model:thinking`) or empty. */
export type ModelTable = { readonly default: string } & { readonly [alias: string]: string };

export interface Models<M extends ModelTable = ModelTable> {
	readonly kind: "models";
	readonly table: M;
}

export function defineModels<const M extends ModelTable>(table: M): Models<M> {
	return { kind: "models", table };
}

// --- Tools ---------------------------------------------------------------------
//
// An agent's tools touch only the outside world (custom tools, MCP); its
// file tools come from its `workspace` access. Exposure is
// permission: a tool given to an agent may be used freely, and the agent
// knows only the tools it is given. Outward writes belong in the workflow
// body; asking first is code (an orchestrator node).

/** Marks values only wallis makes: `tools` takes nothing else. */
const TOOL: unique symbol = Symbol("wallis.tool");

/** What a tool value names, as the host sees it: capabilities beyond the workspace. */
export type ToolDesc =
	| { readonly kind: "ask" }
	| { readonly kind: "custom"; readonly toolset: string; readonly export: string }
	| { readonly kind: "mcp_server"; readonly server: string }
	| { readonly kind: "mcp_tool"; readonly server: string; readonly tool: string };

/** A tool value: built in, from a toolset, or from an MCP server. Only wallis makes them. */
export interface Tool<D extends ToolDesc = ToolDesc> {
	readonly [TOOL]: D;
}

/** The descriptor of a tool value, or null for anything wallis did not make. */
export function toolDesc(value: unknown): ToolDesc | null {
	return value !== null && (typeof value === "object" || typeof value === "function") && TOOL in value ? ((value as Tool)[TOOL] ?? null) : null;
}

const tool = <const D extends ToolDesc>(desc: D): Tool<D> => ({ [TOOL]: desc });

/** `ask(message)`: the agent's question to its caller; the reply is the tool's result. Opt-in. */
export const ask = tool({ kind: "ask" });

/** MCP's ToolAnnotations vocabulary. Unannotated means: may write, outside (MCP's defaults). */
export interface ToolAnnotations {
	readonly title?: string;
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly idempotentHint?: boolean;
	readonly openWorldHint?: boolean;
}

/**
 * A custom tool: a plain pi `AgentTool` (name, label, description,
 * parameters, outputSchema, execute, replay) plus MCP annotations. A tool
 * module exports them; declare each with `satisfies WallisTool<typeof Params>`
 * so `toolset` can type its refs. `replay: "safe"` lets a call in flight at
 * a crash be made again.
 */
export type WallisTool<P extends TSchema = TSchema> = AgentTool<P> & { readonly annotations?: ToolAnnotations };

type ParamsOf<T> = T extends { readonly parameters: infer P extends TSchema } ? Static<P> : never;
type OutputOf<T> = T extends { readonly outputSchema: infer O extends TSchema } ? Static<O> : unknown;

/** A tool of a toolset: for agents' `tools`, and for `ctx.call` with its parameters (and output, if it declares `outputSchema`). */
export interface CustomTool<P = unknown, O = unknown> extends Tool<{ readonly kind: "custom"; readonly toolset: string; readonly export: string }> {
	readonly __types?: { readonly params: P; readonly output: O };
}

const TOOLSET: unique symbol = Symbol("wallis.toolset");

export interface ToolsetOptions {
	/** The sandbox its process runs in; it must require `node`. */
	readonly sandbox: SandboxDef;
	/** Names of environment variables that reach the tools' process, and nothing else. */
	readonly secrets?: readonly string[];
	/** Toolsets reach the outside: `"full"` by default. */
	readonly network?: "none" | "full";
}

export type Toolset<M> = { readonly [K in keyof M as M[K] extends { readonly execute: unknown; readonly parameters: unknown } ? K & string : never]: CustomTool<ParamsOf<M[K]>, OutputOf<M[K]>> } & {
	readonly [TOOLSET]: { readonly path: string } & ToolsetOptions;
};

/**
 * Loads a tool module: `toolset<typeof import("./tools/x.ts")>("./tools/x.ts", { sandbox })`.
 * The import is type-only; at run time only the path (relative to the
 * workflow dir) is used, so the module never enters the workflow VM. wallis
 * bundles it and serves its tools over MCP from their own sandbox.
 */
export function toolset<M>(path: string, options: ToolsetOptions): Toolset<M> {
	const target = { [TOOLSET]: { path, ...options } };
	return new Proxy(target, {
		get: (t, key) => (typeof key === "symbol" ? (t as Record<symbol, unknown>)[key] : tool({ kind: "custom", toolset: path, export: key })),
	}) as unknown as Toolset<M>;
}

export function toolsetDecl(value: unknown): ({ readonly path: string } & ToolsetOptions) | null {
	return value !== null && typeof value === "object" && TOOLSET in value ? (value as { [TOOLSET]: { path: string } & ToolsetOptions })[TOOLSET] : null;
}

// --- Existing MCP servers: an adapter ----------------------------------------------

export interface McpConfig {
	readonly mcpServers: { readonly [server: string]: unknown };
}

/**
 * One MCP tool: `scholar.search`. Its name is checked at preflight
 * (`unknown_tool`). Tool names are not typed, so with
 * `noUncheckedIndexedAccess` the property reads as `McpTool | undefined`;
 * `tools` and `ctx.call` take that (the value is never undefined).
 */
export type McpTool = Tool<{ readonly kind: "mcp_tool"; readonly server: string; readonly tool: string }>;

/** A whole server, for agents: only its tools annotated `readOnlyHint: true` (the others are listed in a warning). */
export type McpServer<S extends string = string> = Tool<{ readonly kind: "mcp_server"; readonly server: S }> & { readonly [tool: string]: McpTool };

const MCP: unique symbol = Symbol("wallis.mcp");

/** Per server in mcp.json: the sandbox its process runs in, and its network (default `"full"`). */
export type McpOverlay<J extends McpConfig> = {
	readonly [S in keyof J["mcpServers"] & string]?: { readonly sandbox?: SandboxDef; readonly network?: "none" | "full" };
};

export type McpServers<J extends McpConfig = McpConfig> = { readonly [S in keyof J["mcpServers"] & string]: McpServer<S> } & {
	readonly [MCP]: { readonly config: J; readonly overlay: McpOverlay<J> };
};

/**
 * Wraps an imported `mcp.json` (`import m from "./mcp.json" with { type: "json" }`)
 * as server objects keyed by name. The TS overlay gives each stdio server its
 * sandbox and network; mcp.json itself stays standard.
 */
export function defineMcp<const J extends McpConfig>(config: J, overlay: McpOverlay<J> = {} as McpOverlay<J>): McpServers<J> {
	const servers: Record<string | symbol, unknown> = { [MCP]: { config, overlay } };
	for (const server of Object.keys(config.mcpServers)) {
		servers[server] = new Proxy(tool({ kind: "mcp_server", server }), {
			get: (t, key) => (typeof key === "symbol" ? (t as unknown as Record<symbol, unknown>)[key] : tool({ kind: "mcp_tool", server, tool: key })),
		});
	}
	return servers as McpServers<J>;
}

export function mcpDecl(value: unknown): { readonly config: McpConfig; readonly overlay: Readonly<Record<string, { readonly sandbox?: SandboxDef; readonly network?: "none" | "full" } | undefined>> } | null {
	return value !== null && typeof value === "object" && MCP in value ? (value as { [MCP]: never })[MCP] : null;
}

// --- Artifacts -------------------------------------------------------------------

/**
 * A file handed downstream: a reference into the run's content-addressed
 * store (`.wallis/runs/<id>/blobs/`). Journal and replay carry only refs.
 */
export function Artifact<const M extends string = string>(media?: M) {
	return Type.Object(
		{
			digest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
			name: Type.String({ minLength: 1 }),
			media: (media === undefined ? Type.String() : Type.Literal(media)) as M extends string ? ReturnType<typeof Type.Literal<M>> : never,
		},
		{ additionalProperties: false },
	);
}

export type ArtifactRef = { readonly digest: string; readonly name: string; readonly media: string };

/**
 * How a producer (a command, or an agent's `export_artifact` tool) names a
 * file in its scratch dir; the host stores it and replaces the draft with an
 * `ArtifactRef` before the result is checked and logged.
 */
export type ArtifactDraft = { readonly artifact: string; readonly media: string; readonly name?: string };

/** Machine resources a command needs; calls wait for a free slot. */
export interface Resources {
	readonly gpu?: number;
	readonly memoryGb?: number;
}

// --- Mounts ----------------------------------------------------------------------

/**
 * Mount table: name -> default host dir. Relative paths resolve against the
 * workflow dir; an empty string means the caller or the local profile must
 * supply it. Mounts are read-only: there is no writable variant. Writes
 * leave a call only as returned artifacts (and a run only through
 * `wallis export`).
 */
export type MountTable = { readonly [name: string]: string };

export interface Mounts<T extends MountTable = MountTable> {
	readonly kind: "mounts";
	readonly table: T;
}

export function defineMounts<const T extends MountTable>(table: T): Mounts<T> {
	return { kind: "mounts", table };
}

// --- Sandboxes -------------------------------------------------------------------

/** A binary the base must provide, checked inside the sandbox (default `<name> --version`). */
export type Requirement<R extends string> = R | { readonly name: R; readonly check: readonly string[] };

export interface SandboxSpec<T extends MountTable, R extends string> {
	/** Names the sandbox in logs, run metadata and the setup cache. */
	readonly name: string;
	/** Commands the base must provide; each is bound alone, read-only, at `/run/wallis/bin/<name>`. */
	readonly requires?: readonly Requirement<R>[];
	/** Run once per digest WITH network, writing into `$WALLIS_ENV`; runs then see it read-only. */
	readonly setup?: readonly (readonly string[])[];
	/** Read-only, by name from `defineMounts`; seen at `/w/<name>`. There is no writable mount. */
	readonly mounts?: readonly (keyof T & string)[];
	/** Reserved for a container backend: an image. bwrap ignores it. */
	readonly base?: string;
}

/**
 * A sandbox the workflow declares. Nothing is implicit: the workflow dir is
 * not mounted; whatever the sandbox needs comes through its mounts. Each call
 * gets a private writable scratch dir (`/w`, the working directory). Agents
 * and commands never have network; only `setup`, and MCP servers (through
 * their overlay), reach outside.
 */
export interface SandboxDef<R extends string = string> {
	readonly kind: "sandbox";
	readonly name: string;
	readonly requires: readonly { readonly name: R; readonly check: readonly string[] }[];
	readonly setup: readonly (readonly string[])[];
	readonly mounts: readonly string[];
	readonly base: string | null;
}

export function defineSandbox<const T extends MountTable, const R extends string = never>(
	_env: { readonly mounts?: Mounts<T> },
	spec: SandboxSpec<T, R>,
): SandboxDef<R> {
	return {
		kind: "sandbox",
		name: spec.name,
		requires: (spec.requires ?? []).map((r) => (typeof r === "string" ? { name: r, check: [r, "--version"] } : r)),
		setup: spec.setup ?? [],
		mounts: [...(spec.mounts ?? [])],
		base: spec.base ?? null,
	};
}

// --- Large inputs --------------------------------------------------------------------

/** The JSON Schema keyword that marks a foldable field. */
export const FOLD = "x-wallis-fold";

/**
 * Marks an input field that may be folded. Fields render in full by
 * default. A foldable field whose canonical JSON is at most `maxChars`
 * renders in full too; a longer one renders as a deterministic skeleton
 * (item counts, field names, the head of long strings). The full input is
 * always the `input` variable inside codemode.
 */
export function Foldable<S extends TSchema>(schema: S, options: { readonly maxChars: number }): S {
	return { ...schema, [FOLD]: { maxChars: options.maxChars } };
}

// --- Commands: typed adapters, called by workflow code only ---------------------

/** An input artifact as a command's `run` sees it: the ref plus where it is mounted. */
export type Mounted<T> = T extends ArtifactRef
	? T & { readonly path: string }
	: T extends readonly (infer E)[]
		? readonly Mounted<E>[]
		: T extends object
			? { readonly [K in keyof T]: Mounted<T[K]> }
			: T;

/** What a command's `parse` gets. */
export interface CommandResult {
	readonly exit: number;
	readonly stdout: string;
	readonly stderr: string;
	/** A file the command wrote in its scratch dir, as an artifact. The host checks it exists (`missing_file`). */
	file<const M extends string = string>(name: string, media?: M): { readonly digest: string; readonly name: string; readonly media: M };
}

/** An argv whose program is one of the sandbox's required binaries. */
export type Argv<R extends string> = readonly [R, ...string[]];

export interface CommandSpec<R extends string, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly description?: string;
	readonly sandbox: SandboxDef<R>;
	readonly input: I;
	readonly output: O;
	/** Pure, run in the workflow sandbox. The input JSON is also on stdin. A plain argv is the default protocol. */
	readonly run: Argv<NoInfer<R>> | ((input: Mounted<Static<I>>) => Argv<NoInfer<R>>);
	/** Pure, run in the workflow sandbox. Default: the output JSON on stdout. Checked against `output` either way. */
	readonly parse?: (result: CommandResult) => Static<O>;
	/** Machine resources; calls wait for free slots. GPU devices are bound only when `gpu` is set. */
	readonly resources?: Resources;
}

export interface CommandDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "command";
	readonly name: string;
	readonly description: string;
	readonly sandbox: SandboxDef;
	readonly input: I;
	readonly output: O;
	readonly run: Argv<string> | ((input: never) => Argv<string>);
	readonly parse: ((result: CommandResult) => unknown) | null;
	readonly resources: Resources;
}

/** A command: a typed adapter around a program in a sandbox. Only workflow code calls it, with `ctx.call`. */
export function command<const R extends string, I extends TSchema, O extends TSchema>(spec: CommandSpec<R, I, O>): CommandDef<I, O> {
	return {
		kind: "command",
		name: spec.name,
		description: spec.description ?? "",
		sandbox: spec.sandbox,
		input: spec.input,
		output: spec.output,
		run: spec.run as CommandDef["run"],
		parse: spec.parse ?? null,
		resources: spec.resources ?? {},
	};
}

// --- Agents --------------------------------------------------------------------

export interface Env<M extends ModelTable> {
	readonly models: Models<M>;
}

interface AgentBase<M extends ModelTable, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly model: keyof M & string;
	/** Prompt text, usually `import p from "./prompts/p.md" with { type: "text" }`. */
	readonly prompt: string;
	/** Everything the agent needs is pushed in here; agents never read workflow memory. */
	readonly input: I;
	/** The result the agent submits; executors pass it to the model as the structured-output schema. */
	readonly output: O;
	readonly skills?: readonly string[];
	/**
	 * Turns per call before the node stops and waits for more
	 * (`Idle(turn_limit)`). The model sees "Turn k of N" every turn. A
	 * codemode call is a turn, so at least 2. Default 16.
	 */
	readonly maxTurns?: number;
	/** Capabilities checked in preflight. */
	readonly needs?: { readonly structuredOutput?: boolean; readonly toolCalls?: boolean; readonly contextTokens?: number };
	/** Default true. A non-steerable node accepts only cancel and a restart without a note. */
	readonly steerable?: boolean;
	/** Default true: an overlong dialogue is compacted (logged); `false`: it fails as `context_exhausted`. */
	readonly compaction?: boolean;
}

/**
 * What an agent may do in its workspace, with tools named as in pi: `read`
 * (read, ls), `write` (also write, edit), `exec` (also bash). `exec` runs
 * commands, so it needs a declared sandbox; without one, `read` and `write`
 * work on a minimal workspace (the input artifacts and a scratch dir, no
 * mounts).
 */
export type Workspace =
	| { readonly access: "read"; readonly sandbox?: SandboxDef }
	| { readonly access: "write"; readonly sandbox?: SandboxDef }
	| { readonly access: "exec"; readonly sandbox: SandboxDef };

/** Resolved access as a rank (none 0, read 1, write 2, exec 3), so a later inference can take the max. */
export type AccessRank = 0 | 1 | 2 | 3;
const RANK = { read: 1, write: 2, exec: 3 } as const;

/**
 * `tools`: the agent's capabilities beyond its workspace, besides codemode
 * and submit_result (always there): `ask`, toolset tools, MCP tools or
 * servers. Without `workspace` the agent has no filesystem at all.
 */
export type AgentSpec<M extends ModelTable, I extends TSchema, O extends TSchema> = AgentBase<M, I, O> & {
	readonly tools?: readonly (Tool | McpTool | undefined)[];
	readonly workspace?: Workspace;
};

export interface AgentDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "agent";
	readonly name: string;
	readonly model: string;
	readonly prompt: string;
	readonly input: I;
	readonly output: O;
	readonly tools: readonly ToolDesc[];
	/** The resolved workspace access: 0 none, 1 read, 2 write, 3 exec. */
	readonly access: AccessRank;
	readonly skills: readonly string[];
	readonly maxTurns: number;
	readonly needs: AgentBase<ModelTable, I, O>["needs"];
	readonly sandbox: SandboxDef | null;
	readonly steerable: boolean;
	readonly compaction: boolean;
}

export function defineAgent<const M extends ModelTable, I extends TSchema, O extends TSchema>(_env: Env<M>, spec: AgentSpec<M, I, O>): AgentDef<I, O> {
	const maxTurns = spec.maxTurns ?? 16;
	// Codemode is always offered and a codemode call is a turn.
	if (maxTurns < 2) throw new Error(`agent ${spec.name}: maxTurns must be at least 2 (a codemode call is a turn)`);
	const tools = (spec.tools ?? []).map((t) => {
		const desc = toolDesc(t);
		if (desc === null) throw new Error(`agent ${spec.name}: tools takes only wallis tool values`);
		return desc;
	});
	if (spec.workspace?.access === "exec" && !spec.workspace.sandbox) throw new Error(`agent ${spec.name}: exec needs a sandbox`);
	return {
		kind: "agent",
		name: spec.name,
		model: spec.model,
		prompt: spec.prompt,
		input: spec.input,
		output: spec.output,
		tools,
		access: spec.workspace ? RANK[spec.workspace.access] : 0,
		skills: spec.skills ?? [],
		maxTurns,
		needs: spec.needs,
		sandbox: spec.workspace?.sandbox ?? null,
		steerable: spec.steerable ?? true,
		compaction: spec.compaction ?? true,
	};
}

// --- Errors the body sees --------------------------------------------------------

/** Why the core refused a request or an event. Mirrors `Refusal` in the core. */
export type Refusal =
	| { readonly type: "pin_mismatch"; readonly field: string; readonly recorded: string; readonly current: string }
	| { readonly type: "path_diverged"; readonly request: string }
	| { readonly type: "unknown_agent"; readonly name: string }
	| { readonly type: "unknown_command"; readonly name: string }
	| { readonly type: "needs_unmet"; readonly agent: string; readonly need: string }
	| { readonly type: "mount_unset"; readonly mount: string }
	| { readonly type: "input_too_large"; readonly agent: string; readonly field: string | null; readonly chars: number; readonly limit: number }
	| { readonly type: "not_owner"; readonly by: string; readonly owner: string | null }
	| { readonly type: "not_idle"; readonly node: string }
	| { readonly type: "node_not_running"; readonly node: string }
	| { readonly type: "not_steerable"; readonly node: string }
	| { readonly type: "not_live"; readonly node: string }
	| { readonly type: "not_an_agent"; readonly node: string }
	| { readonly type: "no_turns_left"; readonly node: string }
	| { readonly type: "requires_missing"; readonly name: string }
	| { readonly type: "requires_broken"; readonly name: string; readonly exit: number; readonly stderr_head: string }
	| { readonly type: "setup_failed"; readonly sandbox: string; readonly exit: number; readonly stderr_head: string }
	| { readonly type: "tool_writes_outside"; readonly server: string; readonly tool: string }
	| { readonly type: "unknown_bin"; readonly name: string }
	| { readonly type: "unknown_alias"; readonly alias: string }
	| { readonly type: "journal_missing"; readonly request: string }
	| { readonly type: "foreign_session"; readonly session: string }
	| { readonly type: "dialogue_missing"; readonly node: string }
	| { readonly type: "session_required"; readonly agent: string }
	| { readonly type: "unknown_orchestrator"; readonly name: string }
	| { readonly type: "unknown_tool"; readonly name: string }
	| { readonly type: "invalid_answer"; readonly node: string; readonly errors: readonly string[] }
	| { readonly type: "not_pending"; readonly node: string }
	| { readonly type: "invalid_declaration"; readonly message: string }
	| { readonly type: "invalid_event"; readonly message: string }
	| { readonly type: "not_started" }
	| { readonly type: "already_started" }
	| { readonly type: "not_running" };

/** Why an agent call failed. Mirrors `AgentFailure` in the core. */
export type AgentFailure =
	| { readonly type: "gave_up"; readonly error: string }
	| { readonly type: "context_exhausted" }
	| { readonly type: "cancelled_by_owner" };

/** Why a command call failed. Mirrors `CommandFailure` in the core. */
export type CommandFailure =
	| { readonly type: "exit_code"; readonly code: number; readonly stderr_head: string }
	| { readonly type: "output_mismatch"; readonly errors: readonly string[] }
	| { readonly type: "timed_out"; readonly minutes: number }
	| { readonly type: "missing_file"; readonly name: string }
	| { readonly type: "unrunnable"; readonly error: string }
	| { readonly type: "command_cancelled" };

/** Why a body MCP tool call failed. Mirrors `ToolFailure` in the core. */
export type ToolFailure =
	| { readonly type: "tool_error"; readonly message: string }
	| { readonly type: "tool_output_mismatch"; readonly errors: readonly string[] }
	| { readonly type: "tool_unreachable"; readonly error: string }
	| { readonly type: "tool_cancelled" };

/** Why a run (or a nested workflow) failed. Mirrors `FailReason` in the core. */
export type FailReason =
	| { readonly type: "body_error"; readonly message: string }
	| { readonly type: "agent_gave_up"; readonly agent: string; readonly failure: AgentFailure }
	| { readonly type: "command_crashed"; readonly command: string; readonly failure: CommandFailure }
	| { readonly type: "tool_crashed"; readonly tool: string; readonly failure: ToolFailure }
	| { readonly type: "orchestrator_cancelled"; readonly name: string }
	| { readonly type: "workflow_failed"; readonly workflow: string; readonly reason: FailReason };

export function failureText(failure: AgentFailure | CommandFailure | ToolFailure): string {
	switch (failure.type) {
		case "tool_error":
			return failure.message;
		case "tool_output_mismatch":
			return `output does not match its schema: ${failure.errors.join("; ")}`;
		case "tool_unreachable":
			return `server unreachable: ${failure.error}`;
		case "tool_cancelled":
			return "cancelled by the owner";
		case "gave_up":
			return failure.error;
		case "context_exhausted":
			return "context exhausted";
		case "cancelled_by_owner":
		case "command_cancelled":
			return "cancelled by the owner";
		case "exit_code":
			return `exited ${failure.code}: ${failure.stderr_head}`;
		case "output_mismatch":
			return `output does not match its schema: ${failure.errors.join("; ")}`;
		case "timed_out":
			return `timed out after ${failure.minutes} minutes`;
		case "missing_file":
			return `it wrote no file ${failure.name}`;
		case "unrunnable":
			return failure.error;
	}
}

export class Refused extends Error {
	override readonly name = "Refused";
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(`refused: ${refusal.type}`);
		this.refusal = refusal;
	}
}

/** The agent call failed: it gave up, ran out of context, or its owner cancelled it. */
export class AgentFailed extends Error {
	override readonly name = "AgentFailed";
	readonly agent: string;
	readonly failure: AgentFailure;
	constructor(agent: string, failure: AgentFailure) {
		super(`${agent}: ${failureText(failure)}`);
		this.agent = agent;
		this.failure = failure;
	}
}

/** The command call failed: exit code, output mismatch, timeout, a missing file, or a cancel. */
export class CommandFailed extends Error {
	override readonly name = "CommandFailed";
	readonly command: string;
	readonly failure: CommandFailure;
	constructor(command: string, failure: CommandFailure) {
		super(`${command}: ${failureText(failure)}`);
		this.command = command;
		this.failure = failure;
	}
}

/** The owner cancelled an orchestrator node instead of answering it. */
export class OrchestratorCancelled extends Error {
	override readonly name = "OrchestratorCancelled";
	readonly orchestrator: string;
	constructor(orchestrator: string) {
		super(`${orchestrator}: cancelled by the owner`);
		this.orchestrator = orchestrator;
	}
}

/** A body tool call failed: an error result, an output mismatch, an unreachable server, or a cancel. */
export class ToolFailed extends Error {
	override readonly name = "ToolFailed";
	readonly tool: string;
	readonly failure: ToolFailure;
	constructor(tool: string, failure: ToolFailure) {
		super(`${tool}: ${failureText(failure)}`);
		this.tool = tool;
		this.failure = failure;
	}
}

/** A nested workflow failed; `reason` is why, typed (it may nest). */
export class WorkflowFailed extends Error {
	override readonly name = "WorkflowFailed";
	readonly workflow: string;
	readonly reason: FailReason;
	constructor(workflow: string, reason: FailReason) {
		super(`${workflow}: ${reason.type}`);
		this.workflow = workflow;
		this.reason = reason;
	}
}

/** The body passed a value that does not match its schema (a node's input). */
export class SchemaError extends Error {
	override readonly name = "SchemaError";
	readonly subject: string;
	readonly errors: readonly string[];
	constructor(subject: string, errors: readonly string[]) {
		super(`${subject} does not match its schema: ${errors.join("; ")}`);
		this.subject = subject;
		this.errors = errors;
	}
}

// --- Nodes and the workflow ------------------------------------------------------

/**
 * Attention points, not hard caps: when spend reaches a limit no new call is
 * admitted and the run goes `Idle(budget_reached)`; calls in flight finish,
 * so a small overshoot is expected. USD and tokens are recorded, never
 * budgeted.
 */
export interface Budget {
	/** Agent model turns for the whole run. */
	readonly turns?: number;
	/** Command compute minutes for the whole run. */
	readonly computeMinutes?: number;
}

export interface PinSpec {
	/** Input files, relative to the project root, digested into the pin. */
	readonly files?: readonly string[];
}

/** A workflow is a node too: calling it runs its body with its own request ids. */
export interface WorkflowNode<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "workflow";
	readonly name: string;
	readonly input: I;
	readonly output: O;
	readonly run: (ctx: Ctx, input: Static<I>) => Promise<Static<O>>;
}

// --- The orchestrator --------------------------------------------------------

/**
 * A node the orchestrator completes (`submit_result`, or `wallis submit`),
 * with a value checked against `output`. Its question must be
 * self-contained: the orchestrator sees only the input. A restart asks
 * again; a cancel is `OrchestratorCancelled` for the body.
 */
export interface OrchestratorDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "orchestrator";
	readonly name: string;
	readonly description: string;
	readonly input: I;
	readonly output: O;
}

export function orchestrator<I extends TSchema, O extends TSchema>(spec: { readonly name: string; readonly description?: string; readonly input: I; readonly output: O }): OrchestratorDef<I, O> {
	return { kind: "orchestrator", name: spec.name, description: spec.description ?? "", input: spec.input, output: spec.output };
}

/** Every node, discriminated by `kind`. Agents are called through sessions; tools are called as values. */
export type Node<I extends TSchema = TSchema, O extends TSchema = TSchema> = AgentDef<I, O> | CommandDef<I, O> | WorkflowNode<I, O> | OrchestratorDef<I, O>;

/** What `ctx.call` takes besides tools: every node but an agent. */
export type CallableNode<I extends TSchema = TSchema, O extends TSchema = TSchema> = CommandDef<I, O> | WorkflowNode<I, O> | OrchestratorDef<I, O>;

/**
 * A conversation with one agent: each `call` appends its input to the same
 * dialogue as a new message and returns the agent's validated output. A
 * session is data, not a process; its identity is where it was created.
 * Calls run one after another, in the order they were made; a call made
 * before the previous one returned waits for it.
 */
export interface Session<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly id: string;
	readonly agent: string;
	/** Only from the branch that created the session: `Refused(foreign_session)` from a `parallel` or `map` branch it started. */
	call(input: Static<I>): Promise<Static<O>>;
}

/**
 * What the workflow body sees: typed calls, each affecting the body only
 * through its return value. Run memory is the body's own local variables.
 *
 * Request ids: `ctx.call` takes its id synchronously, when it is invoked, so
 * `Promise.all([ctx.call(a, x), ctx.call(b, y)])` is deterministic whatever
 * order results arrive in. A branch with several sequential steps must run
 * in `ctx.parallel` or `ctx.map`, which give each branch its own counter:
 * QuickJS has no async context tracking, so ids taken after an `await` in
 * plain concurrent code would depend on arrival order.
 */
export interface Ctx {
	/** Run seed from the pin. `Math.random` is already seeded from it. */
	readonly seed: number;
	/**
	 * Calls a node: a command, a workflow or an orchestrator node (agents go
	 * through `session`). Throws `SchemaError` for a bad input,
	 * `CommandFailed`, `WorkflowFailed` or `OrchestratorCancelled` when it
	 * fails, `Refused` when the core refuses it. A reached budget holds the
	 * call instead.
	 */
	call<I extends TSchema, O extends TSchema>(node: CallableNode<I, O>, input: Static<I>): Promise<Static<O>>;
	/**
	 * Calls a tool from the body (journaled: replay never calls it again):
	 * a toolset tool, typed by its parameters, returns its validated
	 * `structuredContent` (typed by `outputSchema`, else `unknown`, or by
	 * `schema`); an MCP tool returns `unknown` unless `schema` parses it.
	 * Throws `ToolFailed`.
	 */
	call<P, O>(tool: CustomTool<P, O>, input: NoInfer<P>): Promise<O>;
	call<P, S extends TSchema>(tool: CustomTool<P, unknown>, input: NoInfer<P>, schema: S): Promise<Static<S>>;
	call(tool: McpTool | undefined, input: { readonly [key: string]: Json }): Promise<unknown>;
	call<S extends TSchema>(tool: McpTool | undefined, input: { readonly [key: string]: Json }, schema: S): Promise<Static<S>>;
	/** Opens a session with an agent: the only way to call one. It takes its id now, like a call. */
	session<I extends TSchema, O extends TSchema>(agent: AgentDef<I, O>): Session<I, O>;
	/** Runs branches concurrently; each gets its own request ids. */
	parallel<const B extends { readonly [key: string]: (ctx: Ctx) => Promise<unknown> }>(
		branches: B,
	): Promise<{ -readonly [K in keyof B]: Awaited<ReturnType<B[K]>> }>;
	/** One branch per item, concurrently, each with its own request ids; results in item order. */
	map<T, U>(items: readonly T[], each: (ctx: Ctx, item: T, index: number) => Promise<U>): Promise<U[]>;
	/** Monitoring only: logged for `status`, `tree` and `show`, never returned, never matched on replay. */
	observe(label: string, value: Json): void;
}

/** A nested workflow: a node whose body runs inside the caller's run. */
export function subWorkflow<I extends TSchema, O extends TSchema>(spec: Omit<WorkflowNode<I, O>, "kind">): WorkflowNode<I, O> {
	return { kind: "workflow", ...spec };
}

export interface WorkflowSpec<M extends ModelTable, J extends McpConfig, T extends MountTable, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly models: Models<M>;
	/** The MCP servers its agents and body use (`defineMcp`). */
	readonly mcp?: McpServers<J>;
	/** The tool modules its agents and body use (`toolset`). */
	readonly toolsets?: readonly { readonly [TOOLSET]: { readonly path: string } & ToolsetOptions }[];
	readonly mounts?: Mounts<T>;
	/** Every agent the body may call, nested workflows included. */
	readonly agents: readonly AgentDef[];
	/** Every command the body may call, nested workflows included. */
	readonly commands?: readonly CommandDef[];
	/** Every orchestrator node the body may call: the questions the run may ask, with their answer schemas. */
	readonly orchestrators?: readonly OrchestratorDef[];
	readonly budget?: Budget;
	readonly pin?: PinSpec;
	readonly input: I;
	readonly output: O;
	readonly run: (ctx: Ctx, input: Static<I>) => Promise<Static<O>>;
}

export interface WorkflowDef<I extends TSchema = TSchema, O extends TSchema = TSchema> extends WorkflowNode<I, O> {
	readonly spec: WorkflowSpec<ModelTable, McpConfig, MountTable, I, O>;
}

export function workflow<const M extends ModelTable, const J extends McpConfig, const T extends MountTable, I extends TSchema, O extends TSchema>(
	spec: WorkflowSpec<M, J, T, I, O>,
): WorkflowDef<I, O> {
	return { kind: "workflow", name: spec.name, input: spec.input, output: spec.output, run: spec.run, spec: spec as unknown as WorkflowSpec<ModelTable, McpConfig, MountTable, I, O> };
}
