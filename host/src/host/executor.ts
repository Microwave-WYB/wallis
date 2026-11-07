// Executors handle `CallAgent`; script runners handle `RunScript`. The fakes
// answer from scripted responses, for tests and examples: no model, network
// or device.
//
// The contract (round 3):
//   Executor    { id, capabilities, start(NodeSpec) -> NodeSession }
//   NodeSession { turn(message?) -> TurnResult, rebind?(model), handle(), close() }
//   TurnResult  = submitted | ended | agent_error | executor_error
//
// - A node is one agent call and its conversation. `turn()` runs the first
//   turn; `turn(message)` appends a user message and continues. The host keeps
//   the session open while the node is idle and closes it when it is done.
// - `NodeSpec.transcript` is the conversation so far (for a session rebuilt
//   after a restart), so executors need not persist anything themselves.
// - The executor gets the agent's output JSON Schema (provider-side
//   structured output) and validates `submit_result` against it, returning
//   the errors to the model so it can retry within its turn.
// - `ended`: the turn ended without a result; the node goes idle and the
//   message is its question. `agent_error` (gave up, maxTurns) reaches the
//   body as a typed failure. `executor_error` (provider, auth, billing)
//   leaves the call incomplete and pauses the run; so does anything thrown.

import type { ArtifactRef, Json } from "../sdk/index.ts";
import type { Declarations } from "../sdk/runtime.ts";
import { schemaErrors } from "../sdk/validate.ts";
import type { NodeDirs } from "./artifacts.ts";
import type { Message, Usage, Write } from "./core.ts";

export type AgentDeclaration = Declarations["agents"][string];

/** One observational entry of a node's transcript (`nodes/<node>.jsonl`). Never replayed. */
export type TranscriptEntry =
	| { readonly kind: "user"; readonly text: string }
	| { readonly kind: "assistant"; readonly text: string; readonly model?: string }
	| { readonly kind: "tool_call"; readonly tool: string; readonly args: unknown; readonly nested?: boolean }
	| { readonly kind: "tool_result"; readonly tool: string; readonly result: unknown; readonly isError: boolean; readonly nested?: boolean }
	| { readonly kind: "turn"; readonly result: string; readonly usage?: Usage }
	| { readonly kind: "note"; readonly text: string };

export interface NodeSpec {
	readonly id: string;
	readonly agent: string;
	readonly declaration: AgentDeclaration;
	/** Resolved model string (`provider/model[:thinking]`). */
	readonly model: string;
	/** The rendered view: the call's snapshot of the run state. */
	readonly view: string;
	readonly omitted: Readonly<Record<string, number>>;
	readonly input: Json;
	readonly maxTurns: number;
	readonly digest: string;
	/** Messages after the first prompt, so far: the agent's questions and the replies. */
	readonly transcript: readonly Message[];
	/** JSON Schema of the result: pass it to the provider as structured output and check `submit_result` with it. */
	readonly outputSchema: Json;
	/** The node's dirs: its sandbox level, mounted input artifacts, scratch dir and data dirs. */
	readonly workspace: NodeDirs;
	/** The `export_artifact` tool: stores a file from the node's scratch dir and returns its ref for `submit_result`. */
	readonly exportArtifact: (path: string, media: string, name?: string) => ArtifactRef;
	/** Configs of the MCP servers this agent selected (from the workflow's mcp.json). */
	readonly mcp: Json | null;
	/** Appends to the node's observational transcript. */
	readonly log: (entry: TranscriptEntry) => void;
	/** Delivers steering messages queued for a running turn; see `NodeSession.steer`. */
	readonly signal?: AbortSignal;
}

/** What a scripted fake sees for one turn: the spec with the transcript including the current message. */
export type AgentCall = NodeSpec;

export type TurnResult =
	| { readonly type: "submitted"; readonly output: Json; readonly emits?: readonly Write[]; readonly usage?: Usage }
	| { readonly type: "ended"; readonly message: string; readonly usage?: Usage }
	| { readonly type: "agent_error"; readonly error: string; readonly usage?: Usage }
	| { readonly type: "executor_error"; readonly error: string };

export interface NodeSession {
	turn(message?: string): Promise<TurnResult>;
	/** Switches the model for later turns; without it the host restarts the session. */
	rebind?(model: string): void;
	/** Delivers a message to a running turn at its next step boundary. */
	steer?(message: string): void;
	/** Aborts the current generation or tool. */
	interrupt?(): void;
	/** An opaque, JSON-serializable handle for diagnostics. */
	handle(): Json;
	close(): Promise<void> | void;
}

export interface Capabilities {
	readonly structuredOutput?: boolean;
	readonly toolCalls?: boolean;
	readonly contextTokens?: number;
}

export interface Executor {
	readonly id: string;
	readonly capabilities?: Capabilities;
	start(spec: NodeSpec): Promise<NodeSession> | NodeSession;
}

/** The `submit_result` check: empty when the result matches the schema. */
export function validateSubmission(spec: NodeSpec, output: unknown): string[] {
	return schemaErrors(spec.outputSchema, output);
}

export interface ScriptCall {
	readonly id: string;
	readonly script: string;
	readonly args: Json;
	/** Remaining compute budget, for the sandbox to enforce. */
	readonly computeMinutes: number | null;
	readonly digest: string;
	readonly outputSchema: Json;
	readonly workspace: NodeDirs;
	readonly resources: { readonly gpu?: number; readonly memoryGb?: number };
}

export interface ScriptResult {
	readonly output: Json;
	readonly minutes: number;
}

export interface ScriptRunner {
	run(call: ScriptCall): Promise<ScriptResult>;
}

// --- Fakes ---------------------------------------------------------------------

/** One scripted turn of a fake agent. */
export type Turn =
	/** Submits a result. */
	| { readonly submit: Json; readonly emits?: readonly Write[]; readonly usage?: Usage }
	/** Submits each in order until one passes `submit_result` validation; each attempt is a turn. */
	| { readonly submits: readonly Json[]; readonly emits?: readonly Write[]; readonly usage?: Usage }
	/** Ends the turn without a result: the node goes idle with this message. */
	| { readonly idle: string; readonly usage?: Usage }
	/** The executor fails (provider, auth, billing). */
	| { readonly unavailable: string }
	| { readonly giveUp: string; readonly usage?: Usage }
	/** Same as `submit`. */
	| { readonly output: Json; readonly emits?: readonly Write[]; readonly usage?: Usage };

/** A multi-turn conversation: turn i answers the prompt after i replies. */
export interface Conversation {
	readonly conversation: readonly Turn[];
}

export function conversation(...turns: Turn[]): Conversation {
	return { conversation: turns };
}

type Scripted<C, R> = R | ((call: C) => R | Promise<R>);
type Responses<C, R> = Readonly<Record<string, Scripted<C, R> | readonly Scripted<C, R>[]>>;

const TURN_USAGE: Usage = { usd: 0.01, tokens: 100, turns: 1 };

/** Picks `responses[key]`: one response, a function, or a list consumed one per call (the last repeats). */
class Scripts<C, R> {
	readonly #responses: Responses<C, R>;
	readonly #used = new Map<string, number>();

	constructor(responses: Responses<C, R>) {
		this.#responses = responses;
	}

	async pick(key: string, call: C, advance: boolean): Promise<R> {
		const entry = this.#responses[key];
		if (entry === undefined) throw new Error(`no scripted response for ${key}`);
		let response: Scripted<C, R>;
		if (Array.isArray(entry)) {
			const n = this.#used.get(key) ?? 0;
			if (advance) this.#used.set(key, n + 1);
			response = entry[Math.min(advance ? n : Math.max(0, n - 1), entry.length - 1)]!;
		} else {
			response = entry as Scripted<C, R>;
		}
		return typeof response === "function" ? (response as (call: C) => R | Promise<R>)(call) : response;
	}
}

/** One recorded `submit_result` attempt and the errors returned to the model. */
export interface Submission {
	readonly id: string;
	readonly output: Json;
	readonly errors: readonly string[];
}

export class FakeExecutor implements Executor {
	readonly id: string;
	readonly capabilities: Capabilities = { structuredOutput: true, toolCalls: true };
	/** Every turn played, with the transcript up to and including its message. */
	readonly calls: AgentCall[] = [];
	readonly submissions: Submission[] = [];
	readonly #scripts: Scripts<AgentCall, Turn | Conversation>;
	readonly #onCall: ((call: AgentCall) => void) | undefined;

	constructor(
		responses: Responses<AgentCall, Turn | Conversation>,
		options: { id?: string; onCall?: (call: AgentCall) => void } = {},
	) {
		this.#scripts = new Scripts(responses);
		this.#onCall = options.onCall;
		this.id = options.id ?? "fake";
	}

	start(spec: NodeSpec): NodeSession {
		const transcript: Message[] = [...spec.transcript];
		let model = spec.model;
		return {
			turn: async (message) => {
				if (message !== undefined) transcript.push({ role: "user", text: message });
				const call: AgentCall = { ...spec, model, transcript: [...transcript] };
				this.calls.push(call);
				this.#onCall?.(call);
				// A continued call stays on the same scripted response.
				const scripted = await this.#scripts.pick(call.agent, call, transcript.length === 0);
				const replies = transcript.filter((m) => m.role === "user").length;
				const turn = "conversation" in scripted ? scripted.conversation[Math.min(replies, scripted.conversation.length - 1)]! : scripted;
				const result = this.#play(call, turn);
				if (result.type === "ended") transcript.push({ role: "assistant", text: result.message });
				return result;
			},
			rebind: (next) => {
				model = next;
			},
			handle: () => ({ executor: this.id, node: spec.id }),
			close: () => {},
		};
	}

	#play(call: AgentCall, turn: Turn): TurnResult {
		if ("unavailable" in turn) return { type: "executor_error", error: turn.unavailable };
		if ("giveUp" in turn) return { type: "agent_error", error: turn.giveUp, usage: turn.usage ?? TURN_USAGE };
		if ("idle" in turn) return { type: "ended", message: turn.idle, usage: turn.usage ?? TURN_USAGE };
		const attempts = "submits" in turn ? turn.submits : ["submit" in turn ? turn.submit : turn.output];
		for (const [i, output] of attempts.entries()) {
			const n = i + 1;
			const spent = turn.usage ?? { usd: 0.01 * n, tokens: 100 * n, turns: n };
			if (n > call.maxTurns) return { type: "agent_error", error: `maxTurns exceeded (${call.maxTurns})`, usage: spent };
			const errors = validateSubmission(call, output);
			this.submissions.push({ id: call.id, output, errors });
			if (errors.length === 0) return { type: "submitted", output, emits: turn.emits ?? [], usage: spent };
		}
		return { type: "agent_error", error: "gave up: no submit_result passed validation", usage: turn.usage ?? { usd: 0.01, tokens: 100, turns: attempts.length } };
	}
}

export class FakeScripts implements ScriptRunner {
	readonly calls: ScriptCall[] = [];
	readonly #scripts: Scripts<ScriptCall, ScriptResult>;

	constructor(responses: Responses<ScriptCall, ScriptResult>) {
		this.#scripts = new Scripts(responses);
	}

	async run(call: ScriptCall): Promise<ScriptResult> {
		this.calls.push(call);
		return this.#scripts.pick(call.script, call, true);
	}
}
