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

// --- Tools ---------------------------------------------------------------------

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
	| { type: "freeze" }
	| { type: "llm_merge"; agent: string; max: number; max_calls: number; archive: string | null };

/** `W` is what one write carries, `V` the field value. */
export interface Reducer<W = unknown, V = unknown> {
	readonly kind: "reducer";
	readonly spec: ReducerSpec;
	readonly initial: V;
	/** Phantom: the write type. */
	readonly write?: W;
}

function reducer<W, V>(spec: ReducerSpec, initial: V): Reducer<W, V> {
	return { kind: "reducer", spec, initial };
}

type ItemOf<S extends TSchema | undefined, Fallback> = S extends TSchema ? Static<S> : Fallback;

/** Last write wins. */
export function replace<const V extends Json | null>(initial: V): Reducer<Json, Json> {
	return reducer({ type: "replace" }, initial);
}

/** Adds one item per write. Not commutative. */
export function append<S extends TSchema | undefined = undefined>(_item?: S): Reducer<ItemOf<S, Json>, ItemOf<S, Json>[]> {
	return reducer({ type: "append" }, []);
}

/** Set union of the written list; stored sorted. Commutative. */
export function union<S extends TSchema | undefined = undefined>(_item?: S): Reducer<ItemOf<S, Json>[], ItemOf<S, Json>[]> {
	return reducer({ type: "union" }, []);
}

/** Adds numbers. Commutative. */
export function sum(): Reducer<number, number> {
	return reducer({ type: "sum" }, 0);
}

/** Counts keys; a write is one key or a list of keys. Commutative. */
export function countByKey(): Reducer<string | string[], Record<string, number>> {
	return reducer({ type: "count_by_key" }, {});
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

export function topK<S extends TSchema | undefined = undefined>(options: TopKOptions, _item?: S): Reducer<ItemOf<S, Json>, ItemOf<S, Json>[]> {
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
	);
}

/** Appends each write to the list under its key. Never pruned. Not commutative. */
export function appendByKey<S extends TSchema | undefined = undefined>(options: { readonly key: string }, _item?: S): Reducer<ItemOf<S, Json>, Record<string, ItemOf<S, Json>[]>> {
	return reducer({ type: "append_by_key", key: options.key }, {});
}

/** First write wins; later writes are ignored. */
export function freeze<S extends TSchema | undefined = undefined>(_value?: S, initial: Json = null): Reducer<ItemOf<S, Json>, ItemOf<S, Json> | null> {
	return reducer({ type: "freeze" }, initial as ItemOf<S, Json> | null);
}

export interface LlmMergeOptions {
	/** The merge agent. It receives `{ current, incoming, max }` and returns `{ items, archived }`. */
	readonly agent: AgentDef;
	readonly max: number;
	/** Merge calls per run; past the cap the newest `max` items are kept deterministically. */
	readonly maxCalls: number;
	/** State field (usually `append`) that receives archived items. */
	readonly archive?: string;
}

export function llmMerge<S extends TSchema | undefined = undefined>(options: LlmMergeOptions, _item?: S): Reducer<ItemOf<S, Json>[], ItemOf<S, Json>[]> {
	return reducer({ type: "llm_merge", agent: options.agent.name, max: options.max, max_calls: options.maxCalls, archive: options.archive ?? null }, []);
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

export class Refused extends Error {
	override readonly name = "Refused";
}

export class AgentFailed extends Error {
	override readonly name = "AgentFailed";
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
	call<I extends TSchema, O extends TSchema>(agent: AgentDef<I, O>, input: Static<I>): Promise<Static<O>>;
	script(name: string, args?: Json): Promise<Json>;
	read<const K extends keyof F & string>(spec: ViewSpec<K>): Promise<ReadResult<F, K>>;
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
	/** Every agent the body may call, including merge agents. */
	readonly agents: readonly AgentDef[];
	/** Script names under `scripts/`. */
	readonly scripts?: readonly string[];
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
