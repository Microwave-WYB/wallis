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

// --- Scripts and tools ---------------------------------------------------------

/** A domain script under `scripts/`, run in the sandbox. Args and output are checked against the schemas. */
export interface ScriptDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "script";
	readonly name: string;
	readonly description: string;
	readonly input: I;
	readonly output: O;
}

export function defineScript<I extends TSchema, O extends TSchema>(spec: {
	readonly name: string;
	readonly description?: string;
	readonly input: I;
	readonly output: O;
}): ScriptDef<I, O> {
	return { kind: "script", description: "", ...spec };
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

// --- Reducers ------------------------------------------------------------------

/** Wire form of a reducer, as the core decodes it. */
export type ReducerSpec =
	| { type: "replace" }
	| { type: "append" }
	| { type: "union" }
	| { type: "sum" }
	| { type: "count_by_key" }
	| { type: "top_k"; k: number; by: string; order: "ascending" | "descending"; key: string | null; latest: "keep_latest" | "top_only" }
	| { type: "append_by_key"; key: string }
	| { type: "freeze" };

/** `W` is what one write carries, `V` the field value. `schema` validates every write. */
export interface Reducer<W = unknown, V = unknown> {
	readonly kind: "reducer";
	readonly spec: ReducerSpec;
	readonly initial: V;
	readonly schema: TSchema;
	/** Phantom: the write type. */
	readonly write?: W;
}

function reducer<W, V>(spec: ReducerSpec, initial: V, schema: TSchema): Reducer<W, V> {
	return { kind: "reducer", spec, initial, schema };
}

/** Last write wins. */
export function replace<S extends TSchema>(value: S, initial: Static<S> | null = null): Reducer<Static<S>, Static<S> | null> {
	return reducer({ type: "replace" }, initial, value);
}

/** Adds one item per write. Not commutative. */
export function append<S extends TSchema>(item: S): Reducer<Static<S>, Static<S>[]> {
	return reducer({ type: "append" }, [], item);
}

/** Set union of the written list; stored sorted. Commutative. */
export function union<S extends TSchema>(item: S): Reducer<Static<S>[], Static<S>[]> {
	return reducer({ type: "union" }, [], Type.Array(item));
}

/** Adds numbers. Commutative. */
export function sum(): Reducer<number, number> {
	return reducer({ type: "sum" }, 0, Type.Number());
}

/** Counts keys; a write is one key or a list of keys. Commutative. */
export function countByKey(): Reducer<string | string[], Record<string, number>> {
	return reducer({ type: "count_by_key" }, {}, Type.Union([Type.String(), Type.Array(Type.String())]));
}

export interface TopKOptions {
	/** Entries kept by score (the latest write, if kept, comes on top of these). */
	readonly k: number;
	/** Dotted path of the numeric score. */
	readonly by: string;
	readonly order: "ascending" | "descending";
	/** Dotted path of an identity key; a new entry replaces the old one with that key. */
	readonly key?: string;
	/** Also keep the latest write when it is not in the top k. Makes the reducer non-commutative. */
	readonly keepLatest?: boolean;
}

export function topK<S extends TSchema>(options: TopKOptions, item: S): Reducer<Static<S>, Static<S>[]> {
	return reducer(
		{
			type: "top_k",
			k: options.k,
			by: options.by,
			order: options.order,
			key: options.key ?? null,
			latest: options.keepLatest ? "keep_latest" : "top_only",
		},
		[],
		item,
	);
}

/** Appends each write to the list under its key. Never pruned. Not commutative. */
export function appendByKey<S extends TSchema>(options: { readonly key: string }, item: S): Reducer<Static<S>, Record<string, Static<S>[]>> {
	return reducer({ type: "append_by_key", key: options.key }, {}, item);
}

/** First write wins; later writes are ignored. */
export function freeze<S extends TSchema>(value: S, initial: Static<S> | null = null): Reducer<Static<S>, Static<S> | null> {
	return reducer({ type: "freeze" }, initial, value);
}


// --- Pruning helpers -------------------------------------------------------------
//
// Plain functions for body code, not reducers: a body that prunes or merges
// writes the result back with `replace`.

/** The last `n` items, in order. */
export function lastN<T>(items: readonly T[], n: number): T[] {
	return n <= 0 ? [] : items.slice(-n);
}

/** Groups items by key, in first-seen key order, applying `each` to every group. */
export function perKey<T, U = T[]>(items: readonly T[], key: (item: T) => string, each: (group: T[], key: string) => U = (g) => g as U): Record<string, U> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		const group = groups.get(k);
		if (group) group.push(item);
		else groups.set(k, [item]);
	}
	return Object.fromEntries([...groups].map(([k, group]) => [k, each(group, k)]));
}

/**
 * The top `k` items by score. Ties keep their input order; items without a
 * score (null) come last.
 */
export function topKBy<T>(items: readonly T[], k: number, score: (item: T) => number | null, order: "ascending" | "descending"): T[] {
	const sign = order === "descending" ? -1 : 1;
	return items
		.map((item, i) => ({ item, i, s: score(item) }))
		.sort((a, b) => (a.s === null ? (b.s === null ? a.i - b.i : 1) : b.s === null ? -1 : sign * (a.s - b.s) || a.i - b.i))
		.slice(0, Math.max(0, k))
		.map((e) => e.item);
}

/** One item per key, in first-seen order; a later duplicate is folded in with `merge` (default: the first wins). */
export function dedupeBy<T>(items: readonly T[], key: (item: T) => string, merge: (kept: T, next: T) => T = (kept) => kept): T[] {
	const kept = new Map<string, T>();
	for (const item of items) {
		const k = key(item);
		const prior = kept.get(k);
		kept.set(k, prior === undefined ? item : merge(prior, item));
	}
	return [...kept.values()];
}

// --- State and views -----------------------------------------------------------

export type Fields = { readonly [field: string]: Reducer };

export interface State<F extends Fields = Fields> {
	readonly kind: "state";
	readonly fields: F;
}

export function defineState<const F extends Fields>(fields: F): State<F> {
	return { kind: "state", fields };
}

export type ValueOf<R> = R extends Reducer<unknown, infer V> ? V : never;
export type WriteOf<R> = R extends Reducer<infer W, unknown> ? W : never;

export interface ViewSpec<K extends string = string> {
	readonly fields: readonly K[];
	readonly maxChars: number;
	readonly maxItems: number;
	/** Window step for append-only lists. Defaults to a quarter of `maxItems`. */
	readonly chunk?: number;
	/** Keys removed from every object, at any depth. */
	readonly omit?: readonly string[];
}

/** A view over `state`. Field names are checked against the state. */
export function view<F extends Fields, const K extends keyof F & string>(_state: State<F>, spec: ViewSpec<K>): ViewSpec<K> {
	return spec;
}

// --- Agents --------------------------------------------------------------------

export interface Env<M extends ModelTable, F extends Fields, J extends McpConfig> {
	readonly models: Models<M>;
	readonly state?: State<F>;
	readonly mcp?: Mcp<J>;
}

/** Output path (a top-level output key) or `{ emit: true }` for the executor's `emit` tool. */
export type WriteSource<O extends TSchema> = (keyof Static<O> & string) | { readonly emit: true };

export interface AgentSpec<M extends ModelTable, F extends Fields, J extends McpConfig, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly model: keyof M & string;
	/** Prompt text, usually `import p from "./p.md" with { type: "text" }`. */
	readonly prompt: string;
	readonly input: I;
	/** The result the agent submits; executors pass it to the model as the structured-output schema. */
	readonly output: O;
	readonly view?: ViewSpec<keyof F & string>;
	readonly writes?: { readonly [K in keyof F & string]?: WriteSource<O> };
	readonly mcp?: McpSelection<J>;
	readonly tools?: readonly ToolDef[];
	readonly skills?: readonly string[];
	readonly maxTurns?: number;
	/** Capabilities checked in preflight. */
	readonly needs?: { readonly structuredOutput?: boolean; readonly toolCalls?: boolean; readonly contextTokens?: number };
	/** Sandbox for scripts and `sandbox_exec`. `none` means no filesystem at all. */
	readonly sandbox?: "none" | "read-only" | "workspace";
}

export interface AgentDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "agent";
	readonly name: string;
	readonly model: string;
	readonly prompt: string;
	readonly input: I;
	readonly output: O;
	readonly view: ViewSpec;
	readonly writes: { readonly [field: string]: string | { readonly emit: true } };
	readonly mcp: { readonly [server: string]: readonly string[] | "*" };
	readonly tools: readonly ToolDef[];
	readonly skills: readonly string[];
	readonly maxTurns: number;
	readonly needs: AgentSpec<ModelTable, Fields, McpConfig, I, O>["needs"];
	readonly sandbox: "none" | "read-only" | "workspace";
}

const NO_VIEW: ViewSpec = { fields: [], maxChars: 0, maxItems: 0 };

export function defineAgent<const M extends ModelTable, const F extends Fields, const J extends McpConfig, I extends TSchema, O extends TSchema>(
	_env: Env<M, F, J>,
	spec: AgentSpec<M, F, J, I, O>,
): AgentDef<I, O> {
	return {
		kind: "agent",
		name: spec.name,
		model: spec.model,
		prompt: spec.prompt,
		input: spec.input,
		output: spec.output,
		view: spec.view ?? NO_VIEW,
		writes: (spec.writes ?? {}) as AgentDef["writes"],
		mcp: (spec.mcp ?? {}) as AgentDef["mcp"],
		tools: spec.tools ?? [],
		skills: spec.skills ?? [],
		maxTurns: spec.maxTurns ?? 16,
		needs: spec.needs,
		sandbox: spec.sandbox ?? "none",
	};
}

// --- Errors the body sees --------------------------------------------------------

/** Why the core refused a request. Mirrors `Refusal` in the core. */
export type Refusal =
	| { readonly type: "pin_mismatch"; readonly field: string; readonly recorded: string; readonly current: string }
	| { readonly type: "path_diverged"; readonly request: string }
	| { readonly type: "non_commutative_write_in_branch"; readonly field: string; readonly branch: string }
	| { readonly type: "unknown_agent"; readonly name: string }
	| { readonly type: "unknown_script"; readonly name: string }
	| { readonly type: "unknown_field"; readonly field: string }
	| { readonly type: "write_not_allowed"; readonly agent: string; readonly field: string }
	| { readonly type: "reducer_rejected"; readonly field: string; readonly message: string }
	| { readonly type: "needs_unmet"; readonly agent: string; readonly need: string }
	| { readonly type: "not_idle"; readonly node: string }
	| { readonly type: "unknown_alias"; readonly alias: string }
	| { readonly type: "journal_missing"; readonly request: string }
	| { readonly type: "invalid_declaration"; readonly message: string }
	| { readonly type: "invalid_event"; readonly message: string }
	| { readonly type: "not_started" }
	| { readonly type: "already_started" }
	| { readonly type: "not_running" };

/** Why a run failed. Mirrors `FailReason` in the core. */
export type FailReason =
	| { readonly type: "body_error"; readonly message: string }
	| { readonly type: "agent_gave_up"; readonly agent: string; readonly error: string }
	| { readonly type: "script_crashed"; readonly script: string; readonly error: string };

export class Refused extends Error {
	override readonly name = "Refused";
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(`refused: ${refusal.type}`);
		this.refusal = refusal;
	}
}

/** The agent gave up: it hit maxTurns, or never submitted a valid result. */
export class AgentFailed extends Error {
	override readonly name = "AgentFailed";
	readonly agent: string;
	readonly error: string;
	constructor(agent: string, error: string) {
		super(`${agent}: ${error}`);
		this.agent = agent;
		this.error = error;
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

/** The body passed a value that does not match its schema (agent input, script args, a state write). */
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

export interface ReadResult<F extends Fields, K extends keyof F> {
	readonly text: string;
	readonly omitted: { readonly [field: string]: number };
	readonly data: { readonly [P in K]: ValueOf<F[P]> };
}

/** What the workflow body sees. Every method is a request to the core. */
export interface Ctx<F extends Fields> {
	/** Run seed from the pin. `Math.random` is already seeded from it. */
	readonly seed: number;
	/**
	 * Calls an agent. Throws `SchemaError` for a bad input, `AgentFailed` when
	 * the agent gives up, `Refused` when the core refuses the request. An
	 * exhausted budget pauses the run instead of throwing.
	 */
	call<I extends TSchema, O extends TSchema>(agent: AgentDef<I, O>, input: Static<I>): Promise<Static<O>>;
	/** Runs a script. Throws `SchemaError` for bad args, `ScriptFailed` on a crash or a bad output. */
	script<I extends TSchema, O extends TSchema>(script: ScriptDef<I, O>, args: Static<I>): Promise<Static<O>>;
	read<const K extends keyof F & string>(spec: ViewSpec<K>): Promise<ReadResult<F, K>>;
	/** Writes to a state field. Throws `SchemaError` when the value does not match the field. */
	emit<K extends keyof F & string>(field: K, value: WriteOf<F[K]>): Promise<void>;
	/** Runs branches concurrently. Only commutative reducers may be written in them. */
	parallel<const B extends { readonly [key: string]: (ctx: Ctx<F>) => Promise<unknown> }>(
		branches: B,
	): Promise<{ -readonly [K in keyof B]: Awaited<ReturnType<B[K]>> }>;
	/** Runs a sub-workflow. It gets no access to this run's state and returns only its output. */
	sub<I extends TSchema, O extends TSchema>(workflow: SubWorkflowDef<I, O>, input: Static<I>): Promise<Static<O>>;
}

export interface SubWorkflowDef<I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "sub-workflow";
	readonly name: string;
	readonly input: I;
	readonly output: O;
	readonly run: (ctx: Ctx<{}>, input: Static<I>) => Promise<Static<O>>;
}

export function subWorkflow<I extends TSchema, O extends TSchema>(spec: Omit<SubWorkflowDef<I, O>, "kind">): SubWorkflowDef<I, O> {
	return { kind: "sub-workflow", ...spec };
}

export interface WorkflowSpec<M extends ModelTable, F extends Fields, J extends McpConfig, I extends TSchema, O extends TSchema> {
	readonly name: string;
	readonly models: Models<M>;
	readonly state: State<F>;
	readonly mcp?: Mcp<J>;
	/** Every agent the body may call. */
	readonly agents: readonly AgentDef[];
	/** Every script the body may run. */
	readonly scripts?: readonly ScriptDef[];
	readonly budget?: Budget;
	readonly pin?: PinSpec;
	readonly input: I;
	readonly output: O;
	readonly run: (ctx: Ctx<F>, input: Static<I>) => Promise<Static<O>>;
}

export interface WorkflowDef<F extends Fields = Fields, I extends TSchema = TSchema, O extends TSchema = TSchema> {
	readonly kind: "workflow";
	readonly spec: WorkflowSpec<ModelTable, F, McpConfig, I, O>;
}

export function workflow<const M extends ModelTable, const F extends Fields, const J extends McpConfig, I extends TSchema, O extends TSchema>(
	spec: WorkflowSpec<M, F, J, I, O>,
): WorkflowDef<F, I, O> {
	return { kind: "workflow", spec: spec as unknown as WorkflowSpec<ModelTable, F, McpConfig, I, O> };
}
