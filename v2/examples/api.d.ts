// The target public surface of the `wallis` package (v2), declared before the
// implementation. The examples beside this file typecheck against it; v2/lib
// must export exactly this surface (or the examples change with it, reviewed).
//
// Naming (docs/v2.md §3): nodes and resources are lowercase nouns, schema
// builders are Capitalized, operations are verbs.

import Type, { type Static, type TSchema, type TUnsafe } from "typebox";

export { Type };
export type { Static, TSchema };

// ---------------------------------------------------------------------------
// Values

/** A content-addressed file in the project store. `path` is where it is mounted in the current sandbox. */
export interface ArtifactRef<M extends string = string> {
	readonly kind: "artifact";
	readonly digest: string;
	readonly name: string;
	readonly media: M;
	readonly path: string;
}

/** A directory snapshot in the project store, mounted read-only at `path`. */
export interface TreeRef {
	readonly kind: "tree";
	readonly digest: string;
	readonly path: string;
}

/** Where messages of type `M` can be sent. A plain value: pass it in inputs, messages and outputs. */
export interface Address<M = unknown> {
	readonly kind: "address";
	readonly id: string;
	/** Phantom: the message type. */
	__message?(m: M): void;
}

export type MessageId = string & { readonly __messageId: true };

/**
 * What a mailbox yields. `from` is the sender's own address, so a server replies without wiring.
 *
 * Every mailbox has a schema (an agent's or workflow's `mailbox`, an actor's first `spawn`
 * argument, an outbox's). Every message is checked against the RECIPIENT's schema when it is
 * sent, wherever it comes from, before it is journaled; a rejected message is never delivered:
 * - from an agent (its `send` tool): the tool call fails with the errors, so the agent sees what
 *   was wrong and can send again (it costs a turn like any tool error);
 * - from a body or actor (`ctx.send`): throws `MessageRejected`, a bug in the workflow;
 * - from the caller (`run.send`): rejects with `MessageRejected`.
 */
export interface Envelope<M> {
	readonly id: MessageId;
	readonly from: Address<unknown>;
	readonly replyTo?: MessageId;
	readonly body: M;
}

/** An actor's inbox. Ends when the actor that spawned it returns (docs/v2.md §6). */
export interface Mailbox<M> extends AsyncIterable<Envelope<M>> {
	/** The next message, or `closed`. */
	receive(): Promise<Envelope<M> | { readonly closed: true }>;
}

// ---------------------------------------------------------------------------
// Schema builders

export declare const Artifact: {
	<const M extends string = string>(media?: M): TUnsafe<ArtifactRef<M>>;
	/** Caller only: a host file, ingested into the store when the run starts. */
	from<const M extends string = string>(hostPath: string, options?: { media?: M; name?: string }): ArtifactRef<M>;
};

export declare const Tree: {
	(): TUnsafe<TreeRef>;
	/** Caller only: a host directory, snapshotted into the store when the run starts (incremental, reflinked). */
	from(hostPath: string): TreeRef;
};

/**
 * An address whose messages match `message`. As an agent input field, it gives the agent a `send`
 * tool whose parameters are `message`. Passing an address whose recipient's mailbox schema differs
 * from `message` fails the call before the agent starts (schema digests must be equal).
 */
export declare function Address<S extends TSchema>(message: S): TUnsafe<Address<Static<S>>>;

// ---------------------------------------------------------------------------
// Resources

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
export declare function sandbox(spec: SandboxSpec): Sandbox;

/** A tool usable by agents (`tools`) and by bodies (`ctx.call`). */
export interface Tool<I = unknown, O = unknown> {
	readonly kind: "tool";
	__io?(i: I): O;
}

/**
 * A custom tool, as a toolset module exports it: a pi `AgentTool` plus wallis's
 * `outputSchema` (the typed result bodies get from `ctx.call`), MCP-style
 * `annotations`, and `replay: "safe"` for tools that may run again on resume.
 * (Structural here; the real type extends pi's AgentTool.)
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

type ParamsOf<T> = T extends { readonly parameters: infer P extends TSchema } ? Static<P> : never;
type ResultOf<T> = T extends { readonly outputSchema: infer R extends TSchema } ? Static<R> : unknown;
export type Toolset<M> = { readonly [K in keyof M as M[K] extends { readonly execute: unknown; readonly parameters: unknown } ? K : never]: Tool<ParamsOf<M[K]>, ResultOf<M[K]>> };

/** Custom tools: a module of pi `AgentTool`s, run in its own sandboxed process. */
export declare function toolset<M>(
	path: string,
	options?: { readonly sandbox?: Sandbox; readonly network?: "none" | "host"; readonly secrets?: readonly string[] },
): Toolset<M>;

export interface McpConfig {
	readonly mcpServers: Readonly<Record<string, { readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }>>;
}
export type McpServers<J extends McpConfig> = { readonly [S in keyof J["mcpServers"]]: Tool & { readonly [tool: string]: Tool } };
/** Existing MCP servers as tools; `overlay` sets their sandbox and network per server. */
export declare function mcp<const J extends McpConfig>(
	config: J,
	overlay?: { readonly [S in keyof J["mcpServers"]]?: { readonly sandbox?: Sandbox; readonly network?: "none" | "host" } },
): McpServers<J>;

// ---------------------------------------------------------------------------
// Nodes

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
export declare function command<IS extends TSchema, OS extends TSchema>(def: {
	readonly sandbox: Sandbox;
	readonly input: IS;
	readonly output: OS;
	/** argv. Artifact and Tree refs in the input are mounted; their `path` is valid here. */
	readonly run: (input: Static<IS>) => readonly string[];
	/** Default: stdout parsed as JSON against `output`. */
	readonly parse?: (result: CommandResult, input: Static<IS>) => Static<OS>;
}): Command<Static<IS>, Static<OS>>;

export interface Agent<I = unknown, O = unknown, M = never> {
	readonly kind: "agent";
	readonly input: TSchema;
	readonly output: TSchema;
	__io?(i: I, m: M): O;
}
export declare function agent<IS extends TSchema, OS extends TSchema, MS extends TSchema = never>(def: {
	/** An alias from project configuration. */
	readonly model: string;
	readonly prompt: string;
	readonly input: IS;
	readonly output: OS;
	/** Messages to a running call enter its next turn. Without it the agent has no address. */
	readonly mailbox?: MS;
	/** Custom and MCP tools. File tools come from `workspace.access`, never from here. */
	readonly tools?: readonly Tool<any, any>[];
	/** Default: inferred from the signature (Artifact/Tree inputs: read; outputs: write). `exec` is never inferred. */
	readonly workspace?: { readonly access: "read" | "write" | "exec"; readonly sandbox?: Sandbox };
	/** The turn budget of one call. Default 30. Mailbox deliveries count. */
	readonly turns?: number;
}): Agent<Static<IS>, Static<OS>, [MS] extends [never] ? never : Static<MS>>;

/** An immutable agent session. Calling it returns the output and the next session; calling it twice branches. */
export interface Session<I = unknown, O = unknown, M = never> {
	readonly kind: "session";
	__io?(i: I, m: M): O;
}

export interface Workflow<IS extends TSchema = TSchema, OS extends TSchema = TSchema, M = never> {
	readonly kind: "workflow";
	readonly input: IS;
	readonly output: OS;
	__mailbox?(m: M): void;
}
export declare function workflow<IS extends TSchema, OS extends TSchema, MS extends TSchema = never>(def: {
	readonly input: IS;
	readonly output: OS;
	/** The body's own mailbox (for approvals it waits on). Its address is `ctx.self`. */
	readonly mailbox?: MS;
	readonly run: (ctx: Ctx<[MS] extends [never] ? never : Static<MS>>, input: Static<IS>, mailbox: Mailbox<[MS] extends [never] ? never : Static<MS>>) => Promise<Static<OS>>;
}): Workflow<IS, OS, [MS] extends [never] ? never : Static<MS>>;

// ---------------------------------------------------------------------------
// The body

export interface Running<R, M = never> {
	/** Reaches the running call's mailbox (agents and workflows that declare one, actors). */
	readonly address: Address<M>;
	readonly result: Promise<R>;
}

export type Step<S, O> = { readonly next: S } | { readonly done: O };

type Out<N> =
	N extends Agent<any, infer O, any> ? O :
	N extends Command<any, infer O> ? O :
	N extends Tool<any, infer O> ? O :
	N extends Workflow<any, infer OS> ? Static<OS> :
	N extends Session<any, infer O, infer M> ? readonly [O, Session<InOf<N>, O, M>] :
	never;
type InOf<N> =
	N extends Agent<infer I, any, any> ? I :
	N extends Command<infer I, any> ? I :
	N extends Tool<infer I, any> ? I :
	N extends Workflow<infer IS, any> ? Static<IS> :
	N extends Session<infer I, any, any> ? I :
	never;
type MailOf<N> = N extends Agent<any, any, infer M> ? M : N extends Session<any, any, infer M> ? M : N extends Workflow<any, any, infer M> ? M : never;
type Callable = Agent<any, any, any> | Command<any, any> | Tool<any, any> | Workflow<any, any, any> | Session<any, any, any>;

export interface Ctx<Self = never> {
	/**
	 * Run a node and wait. An agent called directly is one-shot: a fresh session, the output only.
	 * A session call returns `[output, nextSession]`, for continuing the same dialogue.
	 */
	call<N extends Callable>(node: N, input: InOf<N>, options?: { readonly turns?: number }): Promise<Out<N>>;
	/** Start a call without waiting. */
	start<N extends Callable>(node: N, input: InOf<N>, options?: { readonly turns?: number }): Running<Out<N>, MailOf<N>>;
	session<I, O, M>(agent: Agent<I, O, M>, options?: { readonly from?: TreeRef }): Session<I, O, M>;
	/** A session's workspace `/w`, as a Tree. */
	files(session: Session<any, any, any>): TreeRef;
	/** An actor: a body task with its own branch and a mailbox whose messages match `mailbox`. */
	spawn<S extends TSchema, R>(mailbox: S, body: (ctx: Ctx<Static<S>>, mailbox: Mailbox<Static<S>>) => Promise<R>): Running<R, Static<S>>;
	/** One spawn per item, results in order. Limit concurrency with plain code (batches). */
	map<T, R>(items: readonly T[], f: (ctx: Ctx, item: T, index: number) => Promise<R>): Promise<R[]>;
	/** A typed fold; each iteration is a branch. */
	loop<S, O>(init: S, step: (ctx: Ctx, state: S) => Promise<Step<S, O>>): Promise<O>;
	/** Never blocks. Checks `body` against the recipient's schema (throws `MessageRejected`). Returns the id replies name in `replyTo`. */
	send<M>(to: Address<M>, body: M, options?: { readonly replyTo?: MessageId; readonly interrupt?: boolean }): MessageId;
	/** This body's or actor's own address. */
	readonly self: Address<Self>;
	/** Expose an address to the caller by name (`run.send(name, …)`). */
	register<M>(name: string, address: Address<M>): void;
	/** An address whose messages go to the caller (`run.next()`). */
	outbox<S extends TSchema>(name: string, message: S): Address<Static<S>>;
}

/** A message that does not match its recipient's mailbox schema. Nothing was delivered. */
export declare class MessageRejected extends Error {
	readonly to: Address<unknown>;
	readonly errors: readonly { readonly path: string; readonly message: string }[];
}

/** A failed call. `reason` is a typed union. */
export declare class NodeFailed extends Error {
	readonly reason:
		| { readonly type: "command_exited"; readonly code: number; readonly stderr: string }
		| { readonly type: "output_invalid"; readonly errors: readonly string[] }
		| { readonly type: "turn_limit_reached"; readonly turns: number; readonly session: Session<any, any, any> }
		| { readonly type: "model_failed"; readonly message: string }
		| { readonly type: "tool_failed"; readonly message: string }
		| { readonly type: "workflow_threw"; readonly message: string };
}

// ---------------------------------------------------------------------------
// The caller API

export type Duration = `${number}${"s" | "m" | "h"}`;

export type Next<O> =
	| { readonly type: "message"; readonly outbox: string; readonly id: MessageId; readonly replyTo?: MessageId; readonly body: unknown }
	| { readonly type: "finished"; readonly output: O }
	| { readonly type: "failed"; readonly error: NodeFailed["reason"] }
	| { readonly type: "stopped" }
	| { readonly type: "timeout"; readonly progress: Status };

export interface Status {
	readonly state: "running" | "stopped" | "finished" | "failed";
	readonly elapsed: Duration;
	readonly completed: number;
	readonly running: readonly string[];
}

export interface Run<O> {
	readonly id: string;
	status(): Promise<Status>;
	tree(): Promise<unknown>;
	transcript(label: string): Promise<unknown>;
	/** The next outbox message, the end of the run, or `timeout` (harnesses cap background waits). */
	next(options?: { readonly timeout?: Duration }): Promise<Next<O>>;
	/** Send to a registered address; rejects with `MessageRejected` if the body does not match its schema. Persisted; a stopped run receives it on resume. */
	send(name: string, body: unknown, options?: { readonly replyTo?: MessageId; readonly interrupt?: boolean }): Promise<MessageId>;
	stop(): Promise<void>;
	resume(options?: { readonly detach?: boolean }): Promise<Run<O>>;
	/** Waits for the end; throws NodeFailed on failure. */
	done(): Promise<Finished<O>>;
}
export interface Finished<O> extends Run<O> {
	readonly output: O;
	/** Copy the output's artifacts and Trees to a host directory. */
	exportOutput(hostDir: string): Promise<void>;
}

/** Run in the foreground and wait for the output. */
export declare function run<IS extends TSchema, OS extends TSchema, M>(wf: Workflow<IS, OS, M>, input: Static<IS>): Promise<Finished<Static<OS>>>;
/** Start a detached run (its own process) and return at once. */
export declare function run<IS extends TSchema, OS extends TSchema, M>(
	wf: Workflow<IS, OS, M>,
	input: Static<IS>,
	options: { readonly detach: true; readonly onExit?: string },
): Promise<Run<Static<OS>>>;

export declare function attach(id: string): Run<unknown>;
export declare function attach<IS extends TSchema, OS extends TSchema, M>(wf: Workflow<IS, OS, M>, id: string): Run<Static<OS>>;
export declare function list(workflowFile: string): Promise<readonly { readonly id: string; readonly state: Status["state"]; readonly started: string }[]>;
/** Delete store data no remaining run references. */
export declare function prune(): Promise<{ readonly freed: number }>;
