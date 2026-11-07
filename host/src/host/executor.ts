// Executors handle `CallAgent`; script runners handle `RunScript`. The fakes
// answer from scripted responses, for tests and examples: no model, network
// or device.
//
// The contract:
// - A call either submits a result or ends its turn without one (`idle`,
//   with the message as the question). A continued call carries the whole
//   transcript, so an executor can be stateless.
// - The executor gets the agent's output JSON Schema, for provider-side
//   structured output, and must validate `submit_result` against it,
//   returning the errors to the model so it can retry within its turn.
// - `AgentFailure` (gave up, maxTurns exceeded) is an agent failure and
//   reaches the workflow body. Anything else thrown, including
//   `ExecutorUnavailable` (provider, auth, billing), leaves the call
//   incomplete and pauses the run.

import type { Json } from "../sdk/index.ts";
import type { Declarations } from "../sdk/runtime.ts";
import { schemaErrors } from "../sdk/validate.ts";
import type { Message, Usage, Write } from "./core.ts";

export type AgentDeclaration = Declarations["agents"][string];

export interface AgentCall {
	readonly id: string;
	readonly agent: string;
	readonly declaration: AgentDeclaration;
	/** Resolved model string. */
	readonly model: string;
	/** The rendered view: the call's snapshot of the run state. */
	readonly view: string;
	readonly omitted: Readonly<Record<string, number>>;
	readonly input: Json;
	readonly maxTurns: number;
	readonly digest: string;
	/** Messages after the first prompt: the agent's questions and the replies. Empty on the first turn. */
	readonly transcript: readonly Message[];
	/** JSON Schema of the result: pass it to the provider as structured output and check `submit_result` with it. */
	readonly outputSchema: Json;
}

export type AgentTurn =
	| { readonly type: "submitted"; readonly output: Json; readonly emits?: readonly Write[]; readonly usage?: Usage }
	| { readonly type: "idle"; readonly message: string; readonly usage?: Usage };

export interface Executor {
	readonly name?: string;
	readonly capabilities?: { readonly structuredOutput?: boolean; readonly toolCalls?: boolean; readonly contextTokens?: number };
	call(call: AgentCall): Promise<AgentTurn>;
}

/** The agent gave up or hit maxTurns. `usage` is what it still spent. */
export class AgentFailure extends Error {
	readonly usage: Usage | undefined;
	constructor(message: string, usage?: Usage) {
		super(message);
		this.usage = usage;
	}
}

/** The executor cannot serve calls (provider down, auth, billing). Not an agent failure. */
export class ExecutorUnavailable extends Error {}

/** The `submit_result` check: empty when the result matches the schema. */
export function validateSubmission(call: AgentCall, output: unknown): string[] {
	return schemaErrors(call.outputSchema, output);
}

export interface ScriptCall {
	readonly id: string;
	readonly script: string;
	readonly args: Json;
	/** Remaining compute budget, for the sandbox to enforce. */
	readonly computeMinutes: number | null;
	readonly digest: string;
	readonly outputSchema: Json;
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
		if (entry === undefined) throw new ExecutorUnavailable(`no scripted response for ${key}`);
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
	readonly name: string;
	readonly calls: AgentCall[] = [];
	readonly submissions: Submission[] = [];
	readonly #scripts: Scripts<AgentCall, Turn | Conversation>;
	readonly #onCall: ((call: AgentCall) => void) | undefined;

	constructor(
		responses: Responses<AgentCall, Turn | Conversation>,
		options: { name?: string; onCall?: (call: AgentCall) => void } = {},
	) {
		this.#scripts = new Scripts(responses);
		this.#onCall = options.onCall;
		this.name = options.name ?? "fake";
	}

	async call(call: AgentCall): Promise<AgentTurn> {
		this.calls.push(call);
		this.#onCall?.(call);
		// A continued call stays on the same scripted response.
		const scripted = await this.#scripts.pick(call.agent, call, call.transcript.length === 0);
		const replies = call.transcript.filter((m) => m.role === "user").length;
		const turn = "conversation" in scripted ? scripted.conversation[Math.min(replies, scripted.conversation.length - 1)]! : scripted;
		return this.#play(call, turn);
	}

	#play(call: AgentCall, turn: Turn): AgentTurn {
		if ("unavailable" in turn) throw new ExecutorUnavailable(turn.unavailable);
		if ("giveUp" in turn) throw new AgentFailure(turn.giveUp, turn.usage ?? TURN_USAGE);
		if ("idle" in turn) return { type: "idle", message: turn.idle, usage: turn.usage ?? TURN_USAGE };
		const attempts = "submits" in turn ? turn.submits : ["submit" in turn ? turn.submit : turn.output];
		for (const [i, output] of attempts.entries()) {
			const n = i + 1;
			const spent = turn.usage ?? { usd: 0.01 * n, tokens: 100 * n, turns: n };
			if (n > call.maxTurns) throw new AgentFailure(`maxTurns exceeded (${call.maxTurns})`, spent);
			const errors = validateSubmission(call, output);
			this.submissions.push({ id: call.id, output, errors });
			if (errors.length === 0) return { type: "submitted", output, emits: turn.emits ?? [], usage: spent };
		}
		throw new AgentFailure("gave up: no submit_result passed validation", turn.usage ?? { usd: 0.01, tokens: 100, turns: attempts.length });
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
