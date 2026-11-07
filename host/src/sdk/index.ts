// The wallis SDK: declarations a workflow.ts is written with.
//
// Everything here is plain data plus the workflow body. It runs inside the
// QuickJS sandbox (no fs, no network, virtual clock, seeded randomness), so
// it must not import Node modules.

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

// --- MCP -----------------------------------------------------------------------

export interface McpConfig {
	readonly mcpServers: { readonly [server: string]: unknown };
}

export interface Mcp<J extends McpConfig = McpConfig> {
	readonly kind: "mcp";
	readonly config: J;
	readonly overlay: McpOverlay<J>;
}

/**
 * Wraps an imported `mcp.json` (`import m from "./mcp.json" with { type: "json" }`).
 * The TS overlay gives each stdio server its sandbox (with its own network
 * allowlist), and names tools allowed to write outside the agent's sandbox.
 */
export function defineMcp<const J extends McpConfig>(config: J, overlay: McpOverlay<J> = {}): Mcp<J> {
	return { kind: "mcp", config, overlay };
}

/** Per agent: a subset of servers, each with a tool allowlist or `"*"`. */
export type McpSelection<J extends McpConfig> = {
	readonly [S in keyof J["mcpServers"] & string]?: readonly string[] | "*";
};

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
	/** Domains the sandbox may reach at run time. Default: none. */
	readonly network?: readonly string[];
	/** Reserved for a container backend: an image. bwrap ignores it. */
	readonly base?: string;
}

/**
 * A sandbox the workflow declares. Nothing is implicit: the workflow dir is
 * not mounted; whatever the sandbox needs comes through its mounts. Each call
 * gets a private writable scratch dir (`/w`, the working directory).
 */
export interface SandboxDef<R extends string = string> {
	readonly kind: "sandbox";
	readonly name: string;
	readonly requires: readonly { readonly name: R; readonly check: readonly string[] }[];
	readonly setup: readonly (readonly string[])[];
	readonly mounts: readonly string[];
	readonly network: readonly string[];
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
		network: [...(spec.network ?? [])],
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

export interface Env<M extends ModelTable, J extends McpConfig> {
	readonly models: Models<M>;
	readonly mcp?: Mcp<J>;
}

export interface AgentSpec<M extends ModelTable, J extends McpConfig, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly model: keyof M & string;
	/** Prompt text, usually `import p from "./prompts/p.md" with { type: "text" }`. */
	readonly prompt: string;
	/** Everything the agent needs is pushed in here; agents never read workflow memory. */
	readonly input: I;
	/** The result the agent submits; executors pass it to the model as the structured-output schema. */
	readonly output: O;
	/** The agent's tools beyond codemode and submit_result: allowlisted MCP tools only. */
	readonly mcp?: McpSelection<J>;
	readonly skills?: readonly string[];
	/**
	 * Turns per call before the node stops and asks its owner for more
	 * (`Idle(turn_limit)`). The model sees "Turn k of N" every turn. A
	 * codemode call is a turn, so at least 2. Default 16.
	 */
	readonly maxTurns?: number;
	/** Capabilities checked in preflight. */
	readonly needs?: { readonly structuredOutput?: boolean; readonly toolCalls?: boolean; readonly contextTokens?: number };
	/**
	 * With a sandbox the agent gets a `bash` tool and file tools confined to
	 * its scratch dir and the sandbox's mounts. Without one it has no
	 * filesystem at all.
	 */
	readonly sandbox?: SandboxDef;
	/** Default true. A non-steerable node accepts only cancel and a restart without a note. */
	readonly steerable?: boolean;
	/** Default true: an overlong dialogue is compacted (logged); `false`: it fails as `context_exhausted`. */
	readonly compaction?: boolean;
}

export interface AgentDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "agent";
	readonly name: string;
	readonly model: string;
	readonly prompt: string;
	readonly input: I;
	readonly output: O;
	readonly mcp: { readonly [server: string]: readonly string[] | "*" };
	readonly skills: readonly string[];
	readonly maxTurns: number;
	readonly needs: AgentSpec<ModelTable, McpConfig, I, O>["needs"];
	readonly sandbox: SandboxDef | null;
	readonly steerable: boolean;
	readonly compaction: boolean;
}

export function defineAgent<const M extends ModelTable, const J extends McpConfig, I extends TSchema, O extends TSchema>(
	_env: Env<M, J>,
	spec: AgentSpec<M, J, I, O>,
): AgentDef<I, O> {
	const maxTurns = spec.maxTurns ?? 16;
	// Codemode is always offered and a codemode call is a turn.
	if (maxTurns < 2) throw new Error(`agent ${spec.name}: maxTurns must be at least 2 (a codemode call is a turn)`);
	return {
		kind: "agent",
		name: spec.name,
		model: spec.model,
		prompt: spec.prompt,
		input: spec.input,
		output: spec.output,
		mcp: (spec.mcp ?? {}) as AgentDef["mcp"],
		skills: spec.skills ?? [],
		maxTurns,
		needs: spec.needs,
		sandbox: spec.sandbox ?? null,
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

/** Why a run (or a nested workflow) failed. Mirrors `FailReason` in the core. */
export type FailReason =
	| { readonly type: "body_error"; readonly message: string }
	| { readonly type: "agent_gave_up"; readonly agent: string; readonly failure: AgentFailure }
	| { readonly type: "command_crashed"; readonly command: string; readonly failure: CommandFailure }
	| { readonly type: "workflow_failed"; readonly workflow: string; readonly reason: FailReason };

export function failureText(failure: AgentFailure | CommandFailure): string {
	switch (failure.type) {
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

/** Everything `ctx.call` can invoke, discriminated by `kind`. */
export type Node<I extends TSchema = TSchema, O extends TSchema = TSchema> = AgentDef<I, O> | CommandDef<I, O> | WorkflowNode<I, O>;

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
	 * Calls a node: an agent, a command or a workflow. Throws `SchemaError`
	 * for a bad input, `AgentFailed`, `CommandFailed` or `WorkflowFailed`
	 * when it fails, `Refused` when the core refuses it. A reached budget
	 * holds the call instead.
	 */
	call<I extends TSchema, O extends TSchema>(node: Node<I, O>, input: Static<I>): Promise<Static<O>>;
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

/** Per server in mcp.json: the sandbox its process runs in, and tools allowed to write outside. */
export type McpOverlay<J extends McpConfig> = {
	readonly [S in keyof J["mcpServers"] & string]?: { readonly sandbox?: SandboxDef; readonly allowWrites?: readonly string[] };
};

export interface WorkflowSpec<M extends ModelTable, J extends McpConfig, T extends MountTable, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly models: Models<M>;
	readonly mcp?: Mcp<J>;
	readonly mounts?: Mounts<T>;
	/** Every agent the body may call, nested workflows included. */
	readonly agents: readonly AgentDef[];
	/** Every command the body may call, nested workflows included. */
	readonly commands?: readonly CommandDef[];
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
