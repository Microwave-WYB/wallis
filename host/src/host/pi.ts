// The pi executor: in process, through pi-agent-core's Agent. No built-in
// tools and no ambient context (no AGENTS.md or CLAUDE.md, no extensions or
// skills): the agent gets its declared prompt, its rendered input, and the
// tools of the wallis tool layer, nothing else.
//
// Durability: after every completed step the node's whole conversation
// (messages, tool calls, results) is checkpointed in its work dir, so a
// reissued or resumed call continues from the last completed turn instead of
// starting over. Transient provider errors (429, 529, 5xx, timeouts, the
// network) are retried with backoff here, before anything is reported.
// Every turn the model sees "Turn k of N" at the end of the newest message;
// at N without a result the node stops (`turn_limit`), progress kept.
//
// Before each model request the context is checked against the model's
// window (3 chars per token). Over it, the older part of the dialogue is
// compacted with pi's summarizer and the compaction is logged; with
// `compaction: false` the call fails as `context_exhausted`.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { estimateTokens, generateSummary } from "@earendil-works/pi-coding-agent";
import type { Json } from "../sdk/index.ts";
import type { Usage } from "./core.ts";
import type { Capabilities, Executor, NodeSession, NodeSpec, TurnResult } from "./executor.ts";
import { CHARS_PER_TOKEN } from "./render.ts";
import { buildNodeTools, type NodeTools, type ToolLayerOptions } from "./tools.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Thinking = (typeof THINKING)[number];

/** What pi-ai's model registry provides: `createModels()` or `builtinModels()` with providers set. */
export interface PiModels {
	getModel(provider: string, id: string): Model<never> | Model<string> | undefined;
	streamSimple: (...args: never[]) => unknown;
}

export interface PiExecutorOptions extends ToolLayerOptions {
	readonly models: PiModels;
	readonly getApiKey?: (provider: string) => string | undefined;
	/** Waits between attempts after a transient provider error (default 5 s, 30 s, 2 min; the local profile's `retries`). */
	readonly retryDelaysMs?: readonly number[];
}

/** `provider/model[:thinking]`; a trailing `:<level>` is a thinking level only if it names one. */
export function parseModel(text: string): { provider: string; id: string; thinking: Thinking | undefined } {
	const slash = text.indexOf("/");
	if (slash <= 0) throw new Error(`model ${text} is not provider/model`);
	let rest = text.slice(slash + 1);
	let thinking: Thinking | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon > 0 && (THINKING as readonly string[]).includes(rest.slice(colon + 1))) {
		thinking = rest.slice(colon + 1) as Thinking;
		rest = rest.slice(0, colon);
	}
	return { provider: text.slice(0, slash), id: rest, thinking };
}

const SYSTEM = `You are one node of a wallis workflow. Work only with the tools you are given; codemode runs a script that can call them all, and sees your full input as \`input\`.
When you are done, call submit_result with a result that matches its schema; if it does not match, you get the errors and may resubmit.
If you cannot continue without an answer from the human, end your turn with your question as plain text instead of calling submit_result.`;

function firstPrompt(spec: NodeSpec): string {
	const parts = [spec.prompt];
	if (spec.note !== null) parts.push(`Operator note (this call was restarted from its input): ${spec.note}`);
	// A session rebuilt after a restart carries the dialogue so far in its first prompt.
	if (spec.transcript.length > 0) {
		parts.push(`Conversation so far:\n${spec.transcript.map((m) => `${m.role === "user" ? "The human" : "You"}: ${m.text}`).join("\n")}`);
	}
	return parts.join("\n\n");
}

/** Tokens kept verbatim at the end of the dialogue when it is compacted: at most a quarter of the budget. */
const KEEP_RECENT_TOKENS = 20_000;
/** Headroom left for the model's reply. */
const RESERVE = 0.2;

function contextTokens(system: string, messages: readonly AgentMessage[]): number {
	return Math.ceil(system.length / CHARS_PER_TOKEN) + messages.reduce((n, m) => n + Math.max(estimateTokens(m), Math.ceil(JSON.stringify(m).length / CHARS_PER_TOKEN)), 0);
}

function textOf(message: AgentMessage | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
}

/** Tools whose call is safe to run again after a crash: they only read. */
const REPLAYABLE = new Set(["read_file", "list_dir", "read_spill", "codemode"]);

/** Provider errors worth retrying (rate limits, overload, 5xx, timeouts, the network); never auth, billing or a missing model. */
export function transientError(message: string): boolean {
	if (/\b(401|402|403|404|412)\b|billing|suspended|invalid api key|unauthori[sz]ed|forbidden|not found|unknown model|insufficient/i.test(message)) return false;
	return /\b(408|409|425|429|5\d\d)\b|overloaded|rate.?limit|too many requests|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network|fetch failed/i.test(message);
}

/** Default backoff for transient errors: 3 attempts after 5 s, 30 s and 2 min. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

const QUOTA = /\n\n\[Turn \d+ of \d+\]$/;

/** What a node's checkpoint holds: the whole conversation after its last completed step, and its turn count. */
interface Checkpoint {
	readonly messages: AgentMessage[];
	readonly turns: number;
	readonly compacted: { summary: AgentMessage; replaces: number } | null;
}

class PiNodeSession implements NodeSession {
	readonly #spec: NodeSpec;
	readonly #tools: NodeTools;
	readonly #agent: Agent;
	readonly #options: PiExecutorOptions;
	#model: string;
	#started = false;
	/** Model turns this node has completed (restored from its checkpoint). */
	#turns: number;
	#limit: number;
	#limitHit = false;
	#exhausted = false;
	/** After a compaction: the summary, and how many leading messages it replaces. */
	#compacted: { summary: AgentMessage; replaces: number } | null = null;

	constructor(spec: NodeSpec, tools: NodeTools, options: PiExecutorOptions) {
		this.#spec = spec;
		this.#tools = tools;
		this.#options = options;
		this.#model = spec.model;
		this.#limit = spec.turnLimit;
		const saved = this.#load();
		this.#turns = Math.max(spec.turn, saved?.turns ?? 0);
		this.#compacted = saved?.compacted ?? null;
		this.#started = saved !== null && saved.messages.length > 0;
		const { model, thinking } = this.#resolve(spec.model);
		const system = `${SYSTEM}\n\n${spec.declaration.prompt}`;
		const streamFn = (options.models.streamSimple as (...a: unknown[]) => never).bind(options.models);
		this.#agent = new Agent({
			initialState: { systemPrompt: system, model: model as never, thinkingLevel: thinking ?? "off", tools: tools.agentTools(), messages: saved?.messages ?? [] },
			streamFn,
			getApiKey: options.getApiKey,
			toolExecution: "sequential",
			transformContext: (messages, signal) => this.#fit(system, messages, streamFn, signal).then((m) => this.#quota(m)),
		});
		if (saved) spec.log({ kind: "note", text: `resumed from its checkpoint after turn ${saved.turns} (${saved.messages.length} messages)` });
		this.#agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const said = textOf(event.message);
				if (said) spec.log({ kind: "assistant", text: said, model: this.#model });
				// A failed request is not progress; anything else is checkpointed before its tools run.
				if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") this.#save();
			}
			if (event.type === "turn_end") {
				// A failed or aborted request is not a completed turn.
				const last = this.#agent.state.messages.at(-1);
				if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) return;
				this.#turns++;
				this.#save();
				if (this.#turns >= this.#limit && this.#tools.submitted === undefined) {
					this.#limitHit = true;
					this.#agent.abort();
				}
			}
		});
	}

	#load(): Checkpoint | null {
		const file = this.#spec.checkpoint;
		if (!existsSync(file)) return null;
		try {
			const saved = JSON.parse(readFileSync(file, "utf8")) as Checkpoint;
			// A reply that failed or was cut off is not progress: drop it.
			const messages = [...saved.messages];
			while (messages.length > 0) {
				const last = messages.at(-1) as { role: string; stopReason?: string };
				if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) messages.pop();
				else break;
			}
			return { ...saved, messages };
		} catch {
			return null;
		}
	}

	/** Atomically: the conversation so far, so a reissued or resumed call continues from here. */
	#save(): void {
		const file = this.#spec.checkpoint;
		mkdirSync(dirname(file), { recursive: true });
		const data: Checkpoint = { messages: this.#agent.state.messages, turns: this.#turns, compacted: this.#compacted };
		writeFileSync(`${file}.tmp`, JSON.stringify(data));
		renameSync(`${file}.tmp`, file);
	}

	/**
	 * "Turn k of N" at the end of the newest message, never the system
	 * prompt, so the cached prefix stays stable. It is written into the
	 * message itself (and so into the checkpoint), deterministically.
	 */
	#quota(messages: AgentMessage[]): AgentMessage[] {
		const last = messages.at(-1) as { role: string; content: unknown } | undefined;
		if (!last || (last.role !== "user" && last.role !== "toolResult")) return messages;
		const note = `\n\n[Turn ${this.#turns + 1} of ${this.#limit}]`;
		if (typeof last.content === "string") last.content = last.content.replace(QUOTA, "") + note;
		else if (Array.isArray(last.content)) {
			const parts = last.content as { type: string; text?: string }[];
			const tail = parts.at(-1);
			if (tail?.type === "text" && tail.text !== undefined) tail.text = tail.text.replace(QUOTA, "") + note;
			else parts.push({ type: "text", text: note.trimStart() });
		}
		this.#spec.log({ kind: "note", text: `turn ${this.#turns + 1} of ${this.#limit}` });
		return messages;
	}

	/**
	 * The window check before each model request. A dialogue over the
	 * window keeps its first prompt and its recent messages; the part in
	 * between is replaced by a summary (logged). Without compaction, or when
	 * even that does not fit, the call fails as `context_exhausted`.
	 */
	async #fit(system: string, all: AgentMessage[], streamFn: (...a: unknown[]) => never, signal?: AbortSignal): Promise<AgentMessage[]> {
		const window = (this.#agent?.state.model as { contextWindow?: number } | undefined)?.contextWindow;
		const view = () => (this.#compacted ? [all[0]!, this.#compacted.summary, ...all.slice(this.#compacted.replaces)] : all);
		if (!window) return view();
		const budget = Math.floor(window * (1 - RESERVE));
		if (contextTokens(system, view()) <= budget) return view();
		if (!this.#spec.declaration.compaction) return this.#exhaust(all, `the dialogue needs ${contextTokens(system, view())} tokens; the window allows ${budget}`);
		// Keep the most recent messages that fit, starting at a user or assistant message.
		let cut = all.length;
		let kept = 0;
		const keep = Math.min(KEEP_RECENT_TOKENS, Math.floor(budget / 4));
		while (cut > 1 && kept + estimateTokens(all[cut - 1]!) <= keep) kept += estimateTokens(all[--cut]!);
		while (cut < all.length && all[cut]!.role === "toolResult") cut++;
		if (cut <= 1) return this.#exhaust(all, "nothing to compact");
		const model = this.#agent.state.model as never;
		const apiKey = await this.#options.getApiKey?.((model as { provider: string }).provider);
		const text = await generateSummary(all.slice(1, cut), model, undefined, apiKey, undefined, signal, undefined, undefined, undefined, streamFn);
		this.#compacted = { summary: { role: "user", content: `Summary of the earlier dialogue (compacted):\n${text}`, timestamp: Date.now() } as never, replaces: cut };
		this.#spec.log({ kind: "note", text: `compacted ${cut - 1} messages into a summary of ${text.length} chars` });
		if (contextTokens(system, view()) > budget) return this.#exhaust(all, "still over the window after compaction");
		return view();
	}

	#exhaust(messages: AgentMessage[], why: string): AgentMessage[] {
		this.#exhausted = true;
		this.#spec.log({ kind: "note", text: `context exhausted: ${why}` });
		this.#agent.abort();
		return messages;
	}

	#resolve(text: string) {
		const { provider, id, thinking } = parseModel(text);
		const model = this.#options.models.getModel(provider, id);
		if (!model) throw new Error(`unknown model ${provider}/${id}`);
		return { model, thinking };
	}

	/**
	 * After a crash the checkpoint may end with an assistant message whose
	 * tool calls never returned. Reads (and codemode) run again; any other
	 * call's result becomes an error the model sees, since it may or may not
	 * have taken effect.
	 */
	async #settleInterrupted(): Promise<void> {
		const messages = this.#agent.state.messages;
		const last = messages.at(-1);
		if (last?.role !== "assistant") return;
		for (const call of last.content) {
			if (call.type !== "toolCall") continue;
			let text: string;
			let isError: boolean;
			if (REPLAYABLE.has(call.name)) {
				const r = await this.#tools.invoke(call.name, call.arguments as Json, false);
				text = this.#tools.cap(r.text);
				isError = r.isError === true;
				this.#spec.log({ kind: "note", text: `re-ran ${call.name} after a crash` });
			} else {
				text = `The host stopped while ${call.name} was running; it may or may not have taken effect. Check before relying on it.`;
				isError = true;
				this.#spec.log({ kind: "note", text: `${call.name} was in flight at a crash: its result is an error for the model` });
			}
			messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: Date.now() } as never);
		}
		this.#agent.state.messages = messages;
	}

	/** One request round, with backoff for transient provider errors (logged); others are reported at once. */
	async #run(start: () => Promise<void>): Promise<{ error: string } | null> {
		const delays = this.#options.retryDelaysMs ?? RETRY_DELAYS_MS;
		for (let attempt = 0; ; attempt++) {
			let error: string | null = null;
			try {
				await start();
				await this.#agent.waitForIdle();
				const last = this.#agent.state.messages.at(-1);
				if (last?.role === "assistant" && last.stopReason === "error") error = last.errorMessage ?? "provider error";
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			if (error === null || this.#exhausted || this.#limitHit) return error === null ? null : { error };
			if (!transientError(error) || attempt >= delays.length) return { error };
			const wait = delays[attempt]!;
			this.#spec.log({ kind: "note", text: `transient executor error (${error}); retry ${attempt + 1} of ${delays.length} in ${wait / 1000} s` });
			await new Promise((r) => setTimeout(r, wait));
			// Drop the failed reply and ask again from the same place.
			const msgs = this.#agent.state.messages;
			if (msgs.at(-1)?.role === "assistant") this.#agent.state.messages = msgs.slice(0, -1);
			start = () => this.#agent.continue();
		}
	}

	async turn(message?: string, turnLimit?: number): Promise<TurnResult> {
		if (turnLimit !== undefined) this.#limit = turnLimit;
		this.#limitHit = false;
		const before = this.#agent.state.messages.length;
		let start: () => Promise<void>;
		if (this.#started && message === undefined) {
			// A reissued or resumed call: continue from the last completed step.
			const last = this.#agent.state.messages.at(-1);
			if (last?.role === "assistant" && last.content.every((c) => c.type !== "toolCall")) return this.#result(before, last);
			await this.#settleInterrupted();
			start = () => this.#agent.continue();
		} else {
			const prompt = this.#started ? (message ?? "") : message === undefined ? firstPrompt(this.#spec) : `${firstPrompt(this.#spec)}\n\nThe human: ${message}`;
			start = () => this.#agent.prompt(prompt);
		}
		this.#started = true;
		const failed = await this.#run(start);
		// Our own abort (context exhausted, turn limit) is not an executor error.
		if (failed && !this.#exhausted && !this.#limitHit) return { type: "executor_error", error: failed.error };
		return this.#result(before, undefined);
	}

	#result(before: number, settledLast: AgentMessage | undefined): TurnResult {
		const fresh = this.#agent.state.messages.slice(before);
		// Completed turns only: a request cut off by our own abort is not a turn.
		const assistant = fresh.filter((m) => m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error");
		const usage: Usage = {
			usd: assistant.reduce((n, m) => n + (m.role === "assistant" ? (m.usage?.cost?.total ?? 0) : 0), 0),
			tokens: assistant.reduce((n, m) => n + (m.role === "assistant" ? (m.usage?.totalTokens ?? 0) : 0), 0),
			turns: assistant.length,
		};
		if (this.#tools.submitted !== undefined) {
			const output = this.#tools.submitted;
			this.#tools.submitted = undefined;
			return { type: "submitted", output, usage };
		}
		if (this.#exhausted) return { type: "agent_error", failure: { type: "context_exhausted" }, usage };
		if (this.#limitHit) return { type: "turn_limit", used: this.#turns, limit: this.#limit, usage };
		const last = settledLast ?? fresh.filter((m) => m.role === "assistant").at(-1);
		const said = textOf(last);
		if (last?.role === "assistant" && last.stopReason === "aborted") return { type: "ended", message: said || "(interrupted)", usage };
		if (!said) return { type: "agent_error", failure: { type: "gave_up", error: "ended its turn without a result or a message" }, usage };
		return { type: "ended", message: said, usage };
	}

	rebind(model: string): void {
		const { model: next, thinking } = this.#resolve(model);
		this.#agent.state.model = next as never;
		if (thinking) this.#agent.state.thinkingLevel = thinking;
		this.#model = model;
	}

	steer(message: string): void {
		this.#agent.steer({ role: "user", content: message, timestamp: Date.now() } as never);
	}

	interrupt(): void {
		this.#agent.abort();
	}

	handle(): Json {
		return { executor: "pi", node: this.#spec.id, model: this.#model, messages: this.#agent.state.messages.length, tools: this.#tools.names };
	}

	async close(): Promise<void> {
		this.#agent.abort();
		await this.#tools.close();
	}
}

export class PiExecutor implements Executor {
	readonly id = "pi";
	readonly capabilities: Capabilities = { structuredOutput: true, toolCalls: true };
	readonly #options: PiExecutorOptions;

	constructor(options: PiExecutorOptions) {
		this.#options = options;
	}

	contextWindow(model: string): number | undefined {
		try {
			const { provider, id } = parseModel(model);
			return (this.#options.models.getModel(provider, id) as { contextWindow?: number } | undefined)?.contextWindow;
		} catch {
			return undefined;
		}
	}

	async start(spec: NodeSpec): Promise<NodeSession> {
		const tools = await buildNodeTools(spec, this.#options);
		return new PiNodeSession(spec, tools, this.#options);
	}
}
