// Executors handle `CallAgent`; script runners handle `RunScript`. The fakes
// answer from a script of responses, for tests and examples: no model,
// network or device.

import type { Json } from "../sdk/index.ts";
import type { Declarations } from "../sdk/runtime.ts";
import type { Usage, Write } from "./core.ts";

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
}

export interface AgentResult {
	readonly output: Json;
	/** Writes buffered by the executor's `emit` tool. */
	readonly emits?: readonly Write[];
	readonly usage?: Usage;
}

export interface Executor {
	call(call: AgentCall): Promise<AgentResult>;
}

/** An executor failure; `usage` is what the failed call still spent. */
export class ExecutorError extends Error {
	readonly usage: Usage | undefined;
	constructor(message: string, usage?: Usage) {
		super(message);
		this.usage = usage;
	}
}

export interface ScriptCall {
	readonly id: string;
	readonly script: string;
	readonly args: Json;
	/** Remaining compute budget, for the sandbox to enforce. */
	readonly computeMinutes: number | null;
	readonly digest: string;
}

export interface ScriptResult {
	readonly output: Json;
	readonly minutes: number;
}

export interface ScriptRunner {
	run(call: ScriptCall): Promise<ScriptResult>;
}

type Scripted<C, R> = R | ((call: C) => R | Promise<R>);

/** Answers each call from `responses[key]`: one response, a function, or a list consumed in order (the last repeats). */
class Scripts<C, R> {
	readonly #responses: Readonly<Record<string, Scripted<C, R> | readonly Scripted<C, R>[]>>;
	readonly #used = new Map<string, number>();

	constructor(responses: Readonly<Record<string, Scripted<C, R> | readonly Scripted<C, R>[]>>) {
		this.#responses = responses;
	}

	async answer(key: string, call: C): Promise<R> {
		const entry = this.#responses[key];
		if (entry === undefined) throw new ExecutorError(`no scripted response for ${key}`);
		let response: Scripted<C, R>;
		if (Array.isArray(entry)) {
			const n = this.#used.get(key) ?? 0;
			this.#used.set(key, n + 1);
			response = entry[Math.min(n, entry.length - 1)]!;
		} else {
			response = entry as Scripted<C, R>;
		}
		return typeof response === "function" ? (response as (call: C) => R | Promise<R>)(call) : response;
	}
}

export class FakeExecutor implements Executor {
	readonly calls: AgentCall[] = [];
	readonly #scripts: Scripts<AgentCall, AgentResult>;
	readonly #onCall: ((call: AgentCall) => void) | undefined;

	constructor(
		responses: Readonly<Record<string, Scripted<AgentCall, AgentResult> | readonly Scripted<AgentCall, AgentResult>[]>>,
		options: { onCall?: (call: AgentCall) => void } = {},
	) {
		this.#scripts = new Scripts(responses);
		this.#onCall = options.onCall;
	}

	async call(call: AgentCall): Promise<AgentResult> {
		this.calls.push(call);
		this.#onCall?.(call);
		const result = await this.#scripts.answer(call.agent, call);
		return { usage: { usd: 0.01, tokens: 100, turns: 1 }, ...result };
	}
}

export class FakeScripts implements ScriptRunner {
	readonly calls: ScriptCall[] = [];
	readonly #scripts: Scripts<ScriptCall, ScriptResult>;

	constructor(responses: Readonly<Record<string, Scripted<ScriptCall, ScriptResult> | readonly Scripted<ScriptCall, ScriptResult>[]>>) {
		this.#scripts = new Scripts(responses);
	}

	async run(call: ScriptCall): Promise<ScriptResult> {
		this.calls.push(call);
		return this.#scripts.answer(call.script, call);
	}
}
