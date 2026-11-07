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
}

/** Wraps an imported `mcp.json` (`import m from "./mcp.json" with { type: "json" }`). */
export function defineMcp<const J extends McpConfig>(config: J): Mcp<J> {
	return { kind: "mcp", config };
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
 * How a producer (a script, or an agent's `export_artifact` tool) names a
 * file in its scratch dir; the host stores it and replaces the draft with an
 * `ArtifactRef` before the result is checked and logged.
 */
export type ArtifactDraft = { readonly artifact: string; readonly media: string; readonly name?: string };

/**
 * What a node may touch on disk. `none`: no filesystem tools. `read-only`:
 * its input artifacts and declared mounts, read-only. `workspace`: the
 * same plus a private writable scratch dir, kept while the node is idle and
 * deleted when it is done.
 */
export type SandboxLevel = "none" | "read-only" | "workspace";

/** Machine resources a script needs; scripts wait for a free slot. */
export interface Resources {
	readonly gpu?: number;
	readonly memoryGb?: number;
}

// --- Mounts ----------------------------------------------------------------------

/**
 * Mount table: name -> default host dir. Relative paths resolve against the
 * workflow dir; an empty string means the caller or the local profile must
 * supply it. Mounts are read-only: there is no writable variant. Writes
 * leave a node only as returned artifacts (and `wallis export`).
 */
export type MountTable = { readonly [name: string]: string };

export interface Mounts<T extends MountTable = MountTable> {
	readonly kind: "mounts";
	readonly table: T;
}

export function defineMounts<const T extends MountTable>(table: T): Mounts<T> {
	return { kind: "mounts", table };
}

// --- Scripts and tools ---------------------------------------------------------

/** A domain script under `scripts/`, run in the sandbox. Args and output are checked against the schemas. */
export interface ScriptDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "script";
	readonly name: string;
	readonly description: string;
	readonly input: I;
	readonly output: O;
	/** Default `workspace`: input artifacts and mounts read-only, a private scratch dir. */
	readonly sandbox: SandboxLevel;
	/** Mounted read-only, by name from the workflow's mount table. */
	readonly mounts: readonly string[];
	readonly resources: Resources;
}

export interface ScriptSpec<T extends MountTable, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly description?: string;
	readonly input: I;
	readonly output: O;
	readonly sandbox?: SandboxLevel;
	readonly mounts?: readonly (keyof T & string)[];
	readonly resources?: Resources;
}

/** `env` is needed only to name mounts: `defineScript({ mounts }, { ..., mounts: ["data"] })`. */
export function defineScript<I extends TSchema, O extends TSchema>(spec: ScriptSpec<{}, I, O>): ScriptDef<I, O>;
export function defineScript<const T extends MountTable, I extends TSchema, O extends TSchema>(env: { readonly mounts: Mounts<T> }, spec: ScriptSpec<T, I, O>): ScriptDef<I, O>;
export function defineScript(a: unknown, b?: unknown): ScriptDef {
	const spec = (b ?? a) as ScriptSpec<MountTable, TSchema, TSchema>;
	return { kind: "script", description: "", sandbox: "workspace", resources: {}, ...spec, mounts: [...(spec.mounts ?? [])] };
}

export interface ToolDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "tool";
	readonly name: string;
	readonly description: string;
	readonly input: I;
	readonly output: O;
	/** Script under `scripts/` that serves the tool, run in the sandbox. */
	readonly script: string;
}

export function defineTool<I extends TSchema, O extends TSchema>(spec: Omit<ToolDef<I, O>, "kind">): ToolDef<I, O> {
	return { kind: "tool", ...spec };
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

// --- Agents --------------------------------------------------------------------

export interface Env<M extends ModelTable, J extends McpConfig, T extends MountTable> {
	readonly models: Models<M>;
	readonly mcp?: Mcp<J>;
	readonly mounts?: Mounts<T>;
}

export interface AgentSpec<M extends ModelTable, J extends McpConfig, T extends MountTable, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly model: keyof M & string;
	/** Prompt text, usually `import p from "./p.md" with { type: "text" }`. */
	readonly prompt: string;
	/** Everything the agent needs is pushed in here; agents never read workflow memory. */
	readonly input: I;
	/** The result the agent submits; executors pass it to the model as the structured-output schema. */
	readonly output: O;
	readonly mcp?: McpSelection<J>;
	readonly tools?: readonly ToolDef[];
	readonly skills?: readonly string[];
	/** Model turns per call. A codemode call is a turn, so at least 2. Default 16. */
	readonly maxTurns?: number;
	/** Capabilities checked in preflight. */
	readonly needs?: { readonly structuredOutput?: boolean; readonly toolCalls?: boolean; readonly contextTokens?: number };
	/** What the node may touch on disk; see `SandboxLevel`. Default `none`. */
	readonly sandbox?: SandboxLevel;
	/** Mounted read-only, by name from the workflow's mount table. */
	readonly mounts?: readonly (keyof T & string)[];
	/**
	 * Default true. A non-steerable node accepts only cancel and a restart
	 * without a note: no answers, steering or interrupts.
	 */
	readonly steerable?: boolean;
	/**
	 * Default true: a dialogue that outgrows the model's window is compacted
	 * (logged). `false`: it fails as `context_exhausted` instead.
	 */
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
	readonly tools: readonly ToolDef[];
	readonly skills: readonly string[];
	readonly maxTurns: number;
	readonly needs: AgentSpec<ModelTable, McpConfig, MountTable, I, O>["needs"];
	readonly sandbox: SandboxLevel;
	readonly mounts: readonly string[];
	readonly steerable: boolean;
	readonly compaction: boolean;
}

export function defineAgent<const M extends ModelTable, const J extends McpConfig, const T extends MountTable, I extends TSchema, O extends TSchema>(
	_env: Env<M, J, T>,
	spec: AgentSpec<M, J, T, I, O>,
): AgentDef<I, O> {
	const maxTurns = spec.maxTurns ?? 16;
	// Codemode is always on and a codemode call is a turn.
	if (maxTurns < 2) throw new Error(`agent ${spec.name}: maxTurns must be at least 2 (a codemode call is a turn)`);
	return {
		kind: "agent",
		name: spec.name,
		model: spec.model,
		prompt: spec.prompt,
		input: spec.input,
		output: spec.output,
		mcp: (spec.mcp ?? {}) as AgentDef["mcp"],
		tools: spec.tools ?? [],
		skills: spec.skills ?? [],
		maxTurns,
		needs: spec.needs,
		sandbox: spec.sandbox ?? "none",
		mounts: [...(spec.mounts ?? [])],
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
	| { readonly type: "unknown_script"; readonly name: string }
	| { readonly type: "needs_unmet"; readonly agent: string; readonly need: string }
	| { readonly type: "mount_unset"; readonly mount: string }
	| { readonly type: "input_too_large"; readonly agent: string; readonly field: string | null; readonly chars: number; readonly limit: number }
	| { readonly type: "not_owner"; readonly by: string; readonly owner: string | null }
	| { readonly type: "not_idle"; readonly node: string }
	| { readonly type: "node_not_running"; readonly node: string }
	| { readonly type: "not_steerable"; readonly node: string }
	| { readonly type: "not_live"; readonly node: string }
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

/** Why a run failed. Mirrors `FailReason` in the core. */
export type FailReason =
	| { readonly type: "body_error"; readonly message: string }
	| { readonly type: "agent_gave_up"; readonly agent: string; readonly failure: AgentFailure }
	| { readonly type: "script_crashed"; readonly script: string; readonly error: string };

export function failureText(failure: AgentFailure): string {
	switch (failure.type) {
		case "gave_up":
			return failure.error;
		case "context_exhausted":
			return "context exhausted";
		case "cancelled_by_owner":
			return "cancelled by the owner";
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

/** The agent call failed: it gave up, ran out of turns or context, or its owner cancelled it. */
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

/** The script crashed, or its output did not match its schema. */
export class ScriptFailed extends Error {
	override readonly name = "ScriptFailed";
	readonly script: string;
	readonly error: string;
	constructor(script: string, error: string) {
		super(`${script}: ${error}`);
		this.script = script;
		this.error = error;
	}
}

/** The body passed a value that does not match its schema (agent input, script args). */
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

// --- Workflow ------------------------------------------------------------------

export interface Budget {
	readonly usd?: number;
	readonly tokens?: number;
	/** Agent turns for the whole run; each call is also capped by its agent's `maxTurns`. */
	readonly turns?: number;
	/** Compute budget passed to scripts and enforced by the sandbox. */
	readonly computeMinutes?: number;
}

export interface PinSpec {
	/** Input files, relative to the project root, digested into the pin. */
	readonly files?: readonly string[];
}

/**
 * What the workflow body sees: typed calls, each affecting the body only
 * through its return value. Run memory is the body's own local variables;
 * a resume rebuilds them by replaying the body over the journal.
 */
export interface Ctx {
	/** Run seed from the pin. `Math.random` is already seeded from it. */
	readonly seed: number;
	/**
	 * Calls an agent. Throws `SchemaError` for a bad input, `AgentFailed` when
	 * the call fails, `Refused` when the core refuses it (for example
	 * `input_too_large`). An exhausted budget pauses the run instead.
	 */
	call<I extends TSchema, O extends TSchema>(agent: AgentDef<I, O>, input: Static<I>): Promise<Static<O>>;
	/** Runs a script. Throws `SchemaError` for bad args, `ScriptFailed` on a crash or a bad output. */
	script<I extends TSchema, O extends TSchema>(script: ScriptDef<I, O>, args: Static<I>): Promise<Static<O>>;
	/** Runs branches concurrently; each gets its own request ids. */
	parallel<const B extends { readonly [key: string]: (ctx: Ctx) => Promise<unknown> }>(
		branches: B,
	): Promise<{ -readonly [K in keyof B]: Awaited<ReturnType<B[K]>> }>;
	/** Runs a sub-workflow and returns its output. */
	sub<I extends TSchema, O extends TSchema>(workflow: SubWorkflowDef<I, O>, input: Static<I>): Promise<Static<O>>;
	/**
	 * Monitoring only: logged for `wallis status`, `tree` and `show`, never
	 * returned to the body and never matched on replay.
	 */
	observe(label: string, value: Json): void;
}

export interface SubWorkflowDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "sub-workflow";
	readonly name: string;
	readonly input: I;
	readonly output: O;
	readonly run: (ctx: Ctx, input: Static<I>) => Promise<Static<O>>;
}

export function subWorkflow<I extends TSchema, O extends TSchema>(spec: Omit<SubWorkflowDef<I, O>, "kind">): SubWorkflowDef<I, O> {
	return { kind: "sub-workflow", ...spec };
}

export interface WorkflowSpec<M extends ModelTable, J extends McpConfig, T extends MountTable, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly models: Models<M>;
	readonly mcp?: Mcp<J>;
	readonly mounts?: Mounts<T>;
	/** Every agent the body may call. */
	readonly agents: readonly AgentDef[];
	/** Every script the body may run. */
	readonly scripts?: readonly ScriptDef[];
	readonly budget?: Budget;
	readonly pin?: PinSpec;
	readonly input: I;
	readonly output: O;
	readonly run: (ctx: Ctx, input: Static<I>) => Promise<Static<O>>;
}

export interface WorkflowDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "workflow";
	readonly spec: WorkflowSpec<ModelTable, McpConfig, MountTable, I, O>;
}

export function workflow<const M extends ModelTable, const J extends McpConfig, const T extends MountTable, I extends TSchema, O extends TSchema>(
	spec: WorkflowSpec<M, J, T, I, O>,
): WorkflowDef<I, O> {
	return { kind: "workflow", spec: spec as unknown as WorkflowSpec<ModelTable, McpConfig, MountTable, I, O> };
}
