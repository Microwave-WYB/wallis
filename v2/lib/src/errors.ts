// The errors a body and a caller see: `NodeFailed` (a failed call, its
// typed reason and where it is) and `MessageRejected` (a message that does
// not match its recipient's mailbox schema). Both carry plain data only.

import type { CommandFailure, FailReason } from "./host/core.ts";
import type { Address } from "./values.ts";

/** A call's journal identity, stable across resumes. */
export type CallId = string & { readonly __callId: true };

/**
 * Where a call is, for people and the orchestrating agent. `label` is the node's const name and
 * definition site (`stitch (film/workflow.ts:93)`), taken when the node is defined; `path` lists
 * the enclosing calls' labels, outermost first.
 */
export interface CallRef {
	readonly id: CallId;
	readonly label: string;
	readonly path: readonly string[];
	readonly attempt: number;
}

/** A session value as a failure carries it (see `nodes.ts`). */
export interface SessionValue {
	readonly kind: "session";
	readonly agent: string;
	readonly id: string | null;
	readonly layers: readonly string[];
}

export type FailureReason =
	| { readonly type: "command_exited"; readonly code: number; readonly stderr: string }
	| { readonly type: "output_invalid"; readonly errors: readonly string[] }
	| { readonly type: "turn_limit_reached"; readonly turns: number; readonly session: SessionValue }
	| { readonly type: "model_failed"; readonly message: string }
	| { readonly type: "tool_failed"; readonly message: string }
	| { readonly type: "workflow_threw"; readonly message: string };

/** A failed call, with what the caller needs to decide how to recover. */
export interface FailedCall extends CallRef {
	readonly reason: FailureReason;
	/** Re-runs on resume by itself (crash, OOM, exit, model or tool error), or only when retried (a decided failure). */
	readonly recovery: "resume" | "retry";
	/** The last lines of stderr (commands), or of the transcript (agents). */
	readonly tail: string;
}

/** A failed call. `reason` is a typed union. */
export class NodeFailed extends Error {
	override readonly name = "NodeFailed";
	readonly call: CallRef;
	readonly reason: FailureReason;
	constructor(call: CallRef, reason: FailureReason) {
		super(`${[...call.path, call.label].join(" > ")}: ${reasonText(reason)}`);
		this.call = call;
		this.reason = reason;
	}
}

/** A message that does not match its recipient's mailbox schema. Nothing was delivered. */
export class MessageRejected extends Error {
	override readonly name = "MessageRejected";
	readonly to: Address<unknown>;
	readonly errors: readonly { readonly path: string; readonly message: string }[];
	constructor(to: Address<unknown>, errors: readonly { path: string; message: string }[]) {
		super(`message to ${to.id} rejected: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
		this.to = to;
		this.errors = errors;
	}
}

export function reasonText(r: FailureReason): string {
	switch (r.type) {
		case "command_exited":
			return `exited ${r.code}${r.stderr ? `: ${r.stderr.split("\n").slice(-3).join(" | ")}` : ""}`;
		case "output_invalid":
			return `output invalid: ${r.errors.join("; ")}`;
		case "turn_limit_reached":
			return `turn limit reached (${r.turns} turns)`;
		case "model_failed":
			return `model failed: ${r.message}`;
		case "tool_failed":
			return `tool failed: ${r.message}`;
		case "workflow_threw":
			return r.message;
	}
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15 };

function commandReason(f: CommandFailure): FailureReason {
	switch (f.type) {
		case "exit_code":
			return { type: "command_exited", code: f.code, stderr: f.stderr_head };
		case "killed":
			return { type: "command_exited", code: 128 + (SIGNALS[f.signal] ?? 0), stderr: `killed by ${f.signal}${f.signal === "SIGKILL" ? " (out of memory?)" : ""}\n${f.stderr_head}` };
		case "output_mismatch":
			return { type: "output_invalid", errors: f.errors };
		case "missing_file":
			return { type: "output_invalid", errors: [`the command wrote no ${f.name}`] };
		case "parse_error":
			return { type: "output_invalid", errors: [`parse threw: ${f.message}`] };
		case "unrunnable":
			return { type: "command_exited", code: 127, stderr: f.error };
	}
}

/** The public reason of a core failure; a nested workflow's failure is its leaf's reason. */
export function publicReason(r: FailReason, session: (id: string) => SessionValue): FailureReason {
	switch (r.type) {
		case "body_error":
			return { type: "workflow_threw", message: r.message };
		case "command_error":
			return commandReason(r.failure);
		case "workflow_error":
			return publicReason(r.reason, session);
		case "agent_error":
			switch (r.failure.type) {
				case "turn_limit_reached":
					return { type: "turn_limit_reached", turns: r.failure.turns, session: session(r.session ?? "") };
				case "invalid_output":
					return { type: "output_invalid", errors: r.failure.errors };
				case "gave_up":
					return { type: "model_failed", message: r.failure.error };
				case "context_exhausted":
					return { type: "model_failed", message: "the dialogue no longer fits the model's context window" };
			}
			break;
		case "tool_error":
			return { type: "tool_failed", message: r.message };
		case "schema_mismatch":
			return { type: "output_invalid", errors: r.errors };
	}
}
