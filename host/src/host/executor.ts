// Executors handle `CallAgent`; command runners (commands.ts) handle `RunCommand`. The fakes
// answer from scripted responses, for tests and examples: no model, network
// or device.
//
// The contract:
//   Executor    { id, capabilities, contextWindow?(model), start(NodeSpec) -> NodeSession }
//   NodeSession { turn(message?) -> TurnResult, rebind?(model), steer?(text), interrupt?(), handle(), close() }
//   TurnResult  = submitted | ended | turn_limit | agent_error | executor_error
//
// An agent is a function: (input, inbox) -> dialogue -> submitted(output) | failure.
// - A node is one agent call and its dialogue. `turn()` runs the first
//   turn; `turn(message)` appends a user message and continues. The host keeps
//   the session open while the node is idle and closes it when it is done.
// - `NodeSpec.transcript` is the conversation so far (for a session rebuilt
//   after a restart), so executors need not persist anything themselves.
// - The executor gets the agent's output JSON Schema (provider-side
//   structured output) and validates `submit_result` against it, returning
//   the errors to the model so it can retry within its turn.
// - A node is one call of a session. `NodeSpec.history` is where the
//   session's previous call left the dialogue: the call continues it.
// - `asked`: the agent called its `ask` tool; the reply arrives as the next
//   `turn(message)` and becomes that tool call's result. `interrupted`: the
//   owner's interrupt aborted the turn. `outcome_unknown`: a reissued call
//   found a tool call in flight at a crash that is not safe to make again.
// - `ended`: the turn ended with neither a result nor a question; the node
//   goes idle with its final text (`Idle(ended_without_result)`). `turn_limit`: the node used its turns without
//   submitting; it goes idle, progress kept, until its owner grants more
//   turns, restarts or cancels it. Every turn the model sees "Turn k of N".
//   `agent_error` (gave up, context exhausted) reaches the body as a typed
//   failure. `executor_error` (provider, auth, billing)
//   leaves the call incomplete and pauses the run; so does anything thrown.
// - A submitted output is `unknown` here: the host parses it against the
//   agent's output schema (and its artifact refs against the store) before
//   anything is logged.

import type { AgentFailure, ArtifactRef, Json } from "../sdk/index.ts";
import type { Declarations } from "../sdk/runtime.ts";
import { schemaErrors } from "../sdk/validate.ts";
import type { NodeDirs } from "./artifacts.ts";
import type { CommandCall, CommandRun, CommandRunner } from "./commands.ts";
import type { Spawn } from "./confine.ts";
import type { McpClient } from "@earendil-works/pi-mcp";
import type { Source } from "./toolsets.ts";
import type { Message, Usage } from "./core.ts";

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
	/** The input as the first prompt shows it: in full, except folded fields. */
	readonly prompt: string;
	/** The full input: the `input` variable inside codemode. */
	readonly input: Json;
	/** An operator note from a restart, for the first prompt. */
	readonly note: string | null;
	/** The resolved model's window in tokens, when the executor knows it. */
	readonly contextTokens: number | undefined;
	/** Model turns this node has used, and how many it may use before it stops (`turn_limit`). */
	readonly turn: number;
	readonly turnLimit: number;
	/**
	 * Checkpoints the node's conversation after every completed step (the
	 * executor's own format): the host writes it as a blob and journals its
	 * digest before it returns, so a reissued call resumes from it.
	 */
	readonly checkpoint: (state: Json) => void;
	/** This call's newest checkpoint, when it is reissued after a crash; else null. */
	readonly resume: Json | null;
	/** The call's journal slot. */
	readonly slot: string;
	/** Messages after the first prompt, so far: the agent's questions and the replies. */
	readonly transcript: readonly Message[];
	/** The session's dialogue after its previous call (the executor's checkpoint format), or null for its first call. */
	readonly history: Json | null;
	/** The owner restarted an unknown outcome: make the unknown tool call again (once) instead of reporting it. */
	readonly retryUnknown: boolean;
	/** MCP tool results already journaled for this call, by tool call key. */
	readonly recorded: ReadonlyMap<string, Json>;
	/** Journals an MCP tool result of this call before the model sees it. */
	readonly record: (call: string, result: Json) => void;
	/** JSON Schema of the result: pass it to the provider as structured output and check `submit_result` with it. */
	readonly outputSchema: Json;
	/** The node's dirs: mounted input artifacts, scratch dir, mounts and spill dir. */
	readonly workspace: NodeDirs;
	/** The agent's sandbox, for its `bash` and file tools. */
	readonly sandbox: AgentSandbox;
	/** The `export_artifact` tool: stores a file from the node's scratch dir and returns its ref for `submit_result`. */
	readonly exportArtifact: (path: string, media: string, name?: string) => ArtifactRef;
	/** A new connection to one of the agent's tool sources (a toolset or an MCP server), for this call. */
	readonly connect: (source: Source) => Promise<McpClient>;
	/** Reports a preflight-style warning (a tool that may write outside, tools left out): run metadata and the transcript. */
	readonly warn: (text: string) => void;
	/** Appends to the node's observational transcript. */
	readonly log: (entry: TranscriptEntry) => void;
}

/**
 * An agent's sandbox: none declared (no filesystem at all), one the host
 * can build (bwrap), or one declared that cannot be built here.
 */
export type AgentSandbox =
	| { readonly type: "none" }
	| { readonly type: "bwrap"; readonly name: string; readonly spawn: (argv: readonly string[]) => Spawn }
	| { readonly type: "unavailable"; readonly name: string; readonly reason: string };

/** What a scripted fake sees for one turn: the spec with the transcript including the current message. */
export type AgentCall = NodeSpec;

export type TurnResult =
	| { readonly type: "submitted"; readonly output: unknown; readonly usage?: Usage }
	| { readonly type: "ended"; readonly message: string; readonly usage?: Usage }
	/** The agent called `ask`: it waits for its caller's reply. */
	| { readonly type: "asked"; readonly message: string; readonly usage?: Usage }
	/** A tool call in flight at a crash, not safe to make again: whether it took effect is unknown. */
	| { readonly type: "outcome_unknown"; readonly tool: string; readonly args: Json; readonly usage?: Usage }
	/** The owner's interrupt aborted the turn; progress is kept. */
	| { readonly type: "interrupted"; readonly usage?: Usage }
	| { readonly type: "agent_error"; readonly failure: AgentFailure; readonly usage?: Usage }
	/** The node used its turns without submitting: it waits for more (progress kept). */
	| { readonly type: "turn_limit"; readonly used: number; readonly limit: number; readonly usage?: Usage }
	| { readonly type: "executor_error"; readonly error: string };

export interface NodeSession {
	/** `turnLimit`: the node's allowance now (an answer may grant more turns). */
	turn(message?: string, turnLimit?: number): Promise<TurnResult>;
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
	/** The model's context window in tokens, for the window check before a call. */
	contextWindow?(model: string): number | undefined;
	start(spec: NodeSpec): Promise<NodeSession> | NodeSession;
}

/** The `submit_result` check: empty when the result matches the schema. */
export function validateSubmission(spec: NodeSpec, output: unknown): string[] {
	return schemaErrors(spec.outputSchema, output);
}

// --- Fakes ---------------------------------------------------------------------

/** One scripted turn of a fake agent. */
export type Turn =
	/** Submits a result. */
	| { readonly submit: Json; readonly usage?: Usage }
	/** Submits each in order until one passes `submit_result` validation; each attempt is a turn. */
	| { readonly submits: readonly Json[]; readonly usage?: Usage }
	/** Ends the turn without a result: the node goes idle with this message. */
	| { readonly idle: string; readonly usage?: Usage }
	/** Calls `ask`: the node waits for a reply. */
	| { readonly ask: string; readonly usage?: Usage }
	/** The executor fails (provider, auth, billing). */
	| { readonly unavailable: string }
	| { readonly giveUp: string; readonly usage?: Usage }
	/** The dialogue outgrew the window with compaction off. */
	| { readonly contextExhausted: true; readonly usage?: Usage }
	/** Same as `submit`. */
	| { readonly output: Json; readonly usage?: Usage };

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

	readonly #window: number | undefined;

	constructor(
		responses: Responses<AgentCall, Turn | Conversation>,
		options: { id?: string; onCall?: (call: AgentCall) => void; contextWindow?: number } = {},
	) {
		this.#scripts = new Scripts(responses);
		this.#onCall = options.onCall;
		this.id = options.id ?? "fake";
		this.#window = options.contextWindow;
	}

	contextWindow(_model: string): number | undefined {
		return this.#window;
	}

	start(spec: NodeSpec): NodeSession {
		const transcript: Message[] = [...spec.transcript];
		let model = spec.model;
		let used = spec.turn;
		let limit = spec.turnLimit;
		return {
			turn: async (message, turnLimit) => {
				if (turnLimit !== undefined) limit = turnLimit;
				if (message !== undefined) transcript.push({ role: "user", text: message });
				const call: AgentCall = { ...spec, model, transcript: [...transcript], turn: used, turnLimit: limit };
				this.calls.push(call);
				this.#onCall?.(call);
				// A continued call stays on the same scripted response.
				const scripted = await this.#scripts.pick(call.agent, call, transcript.length === 0);
				const replies = transcript.filter((m) => m.role === "user").length;
				const turn = "conversation" in scripted ? scripted.conversation[Math.min(replies, scripted.conversation.length - 1)]! : scripted;
				const result = this.#play(call, turn);
				if (result.type !== "executor_error") used += result.usage?.turns ?? 0;
				if (result.type === "turn_limit") used = result.used;
				if (result.type === "ended" || result.type === "asked") transcript.push({ role: "assistant", text: result.message });
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
		if ("giveUp" in turn) return { type: "agent_error", failure: { type: "gave_up", error: turn.giveUp }, usage: turn.usage ?? TURN_USAGE };
		if ("contextExhausted" in turn) return { type: "agent_error", failure: { type: "context_exhausted" }, usage: turn.usage ?? TURN_USAGE };
		if ("idle" in turn) return { type: "ended", message: turn.idle, usage: turn.usage ?? TURN_USAGE };
		if ("ask" in turn) return { type: "asked", message: turn.ask, usage: turn.usage ?? TURN_USAGE };
		const attempts = "submits" in turn ? turn.submits : ["submit" in turn ? turn.submit : turn.output];
		for (const [i, output] of attempts.entries()) {
			const n = i + 1;
			const spent = turn.usage ?? { usd: 0.01 * n, tokens: 100 * n, turns: n };
			if (call.turn + n > call.turnLimit) {
				return { type: "turn_limit", used: call.turnLimit, limit: call.turnLimit, usage: turn.usage ?? { usd: 0.01 * i, tokens: 100 * i, turns: i } };
			}
			const errors = validateSubmission(call, output);
			this.submissions.push({ id: call.id, output, errors });
			if (errors.length === 0) return { type: "submitted", output, usage: spent };
		}
		return {
			type: "agent_error",
			failure: { type: "gave_up", error: "gave up: no submit_result passed validation" },
			usage: turn.usage ?? { usd: 0.01, tokens: 100, turns: attempts.length },
		};
	}
}

/** A scripted command: what it prints, and the files it writes in its scratch dir. */
export type FakeRun = { readonly stdout?: string; readonly stderr?: string; readonly exit?: number; readonly minutes?: number; readonly timedOut?: boolean };

/** Plays scripted command results; a function may write files into `call.workspace.scratch` first. */
export class FakeCommands implements CommandRunner {
	readonly calls: CommandCall[] = [];
	readonly #scripts: Scripts<CommandCall, FakeRun>;

	constructor(responses: Responses<CommandCall, FakeRun>) {
		this.#scripts = new Scripts(responses);
	}

	async run(call: CommandCall): Promise<CommandRun> {
		this.calls.push(call);
		const r = await this.#scripts.pick(call.command, call, true);
		return { exit: r.exit ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", minutes: r.minutes ?? 0, timedOut: r.timedOut ?? false };
	}
}
