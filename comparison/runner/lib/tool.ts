// SDK-neutral types: a tool is a TypeBox schema plus a plain function, and
// an agent run ends in one of three ways. lib/agent.<sdk>.ts converts these
// to and from its SDK; nothing else in the project imports an SDK.

import type { Static, TSchema } from "typebox";

export interface ToolResult {
	readonly text: string;
	readonly isError?: boolean;
}

export interface Tool<P extends TSchema = TSchema> {
	readonly name: string;
	readonly description: string;
	readonly parameters: P;
	execute(args: Static<P>, signal?: AbortSignal): Promise<ToolResult>;
}

/** Keeps the parameter type for `execute` when declaring a tool inline. */
export function tool<P extends TSchema>(spec: Tool<P>): Tool {
	return spec as unknown as Tool;
}

export interface AgentSpec<O extends TSchema> {
	/** `provider/model`, resolved by the SDK variant. */
	readonly model: string;
	readonly system: string;
	readonly tools?: readonly Tool[];
	/** The result's schema; the agent submits it through a validated `submit_result` tool. */
	readonly output: O;
	/** Model turns before it stops (`failed`, kind `turn_limit`). Default 12. Each request shows "[Turn k of N]". */
	readonly maxTurns?: number;
	/** A file: the conversation is saved after every turn, and a later call with the same file continues it. */
	readonly session?: string;
	/** Continue a saved session with this message (an answer to its question). */
	readonly answer?: string;
	/** Waits (ms) before retrying a transient provider error. Default 5 s, 30 s, 2 min. */
	readonly retries?: readonly number[];
	readonly log?: (line: string) => void;
	/** Reasoning effort for models that support it. Default "off". */
	readonly thinking?: "off" | "minimal" | "low" | "medium" | "high";
	/** Called once with a handle for steering or aborting the running agent; returns a cleanup. */
	readonly attach?: (handle: AgentHandle) => () => void;
	/** Called after every completed turn. */
	readonly onTurn?: (info: { readonly turn: number; readonly text: string; readonly usage: Usage }) => void;
}

export interface AgentHandle {
	/** Delivered after the current turn and its tool calls. */
	steer(text: string): void;
	abort(): void;
	/** The SDK's own agent object, for live inspection from a console. */
	readonly raw: unknown;
}

export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
}

/** How an agent run ended: a valid result, a question for its caller, or a failure. */
export type AgentResult<T> =
	| { readonly type: "submitted"; readonly value: T; readonly turns: number }
	| { readonly type: "question"; readonly message: string; readonly turns: number }
	| { readonly type: "failed"; readonly kind: "turn_limit" | "provider" | "no_result"; readonly error: string; readonly turns: number };

/** The submitted value, or an error naming how the run ended. */
export function submitted<T>(result: AgentResult<T>): T {
	if (result.type === "submitted") return result.value;
	throw new Error(result.type === "question" ? `the agent asked: ${result.message}` : `the agent failed (${result.kind}): ${result.error}`);
}
