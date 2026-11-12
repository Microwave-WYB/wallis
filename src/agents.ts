// The pi executor, v2 (docs/v2.md §4.2, §6). One agent call runs in this
// process through pi-agent-core's Agent: its declared prompt, its input,
// and the tools of the v2 agent model, nothing else:
//
// - `submit_result`: the output, checked against the agent's schema; an
//   invalid one comes back to the agent with the errors, and after three
//   the call fails, decided, as `output_invalid`.
// - `send`: one tool for every `Address` input; each message is checked
//   against its recipient's mailbox schema, and a rejected one comes back
//   to the agent with the errors (path and message), so it can resend.
// - file tools from workspace access: `read`, `ls` (read); `write`, `edit`
//   (write); `bash` (exec). Each runs in a fresh bwrap process over the
//   call's view: /w (its session's layers, the call's own upper dir), /in
//   (its input artifacts and Trees, and those of every message it took).
// - the agent's custom and MCP tools.
//
// The mailbox: messages that arrive while a turn runs enter the next turn,
// together; one sent with `interrupt` aborts the current turn first. An
// agent with a mailbox that ends a turn without a result waits for its next
// message. Each message is journaled with the turn it was taken after.
//
// The turn budget: every model turn counts, deliveries included. At the
// budget without a result the call fails, decided, as `turn_limit_reached`
// with its dialogue, so a retry continues the same session.
//
// Durability: after every completed turn the dialogue is checkpointed (a
// blob, then `agent_progressed`), so a reissued call continues from its last
// turn. Transient provider errors are retried with backoff here.

import { mkdirSync } from "node:fs";
import { join, posix } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { estimateTokens, generateSummary } from "@earendil-works/pi-coding-agent";
import Type, { type TSchema } from "typebox";
import Value from "typebox/value";
import { mountPoint, mountsOf } from "./commands.ts";
import type { Effect, Envelope as CoreEnvelope, Event, Json } from "./host/core.ts";
import { putDialogue, readDialogue } from "./host/dialogues.ts";
import { crashPoint } from "./host/faults.ts";
import { splitImages } from "./host/images.ts";
import type { Journal } from "./host/journal.ts";
import { commitLayer, layersAfter, prepareWork, removeWork, type Work, xattrToolsMissing } from "./host/layers.ts";
import { callDir, type RunPaths } from "./host/runs.ts";
import { head, runSpawn, type SandboxPlan, sandboxed } from "./host/sandbox.ts";
import type { Store } from "./host/store.ts";
import type { AgentDef } from "./nodes.ts";
import type { LiveMailbox } from "./runtime.ts";
import type { Connection, ToolCaller } from "./toolcalls.ts";
import { addressesIn, errorText, guessMedia, MARK, schemaErrors, stripPaths, toJson, withPaths } from "./values.ts";

/** What pi-ai's model registry provides: `createModels()` or `builtinModels()` with providers set. */
export interface PiModels {
	getModel(provider: string, id: string): Model<never> | Model<string> | undefined;
	streamSimple: (...args: never[]) => unknown;
}

/** What the run gives an agent call. */
export interface AgentHost {
	readonly store: Store;
	readonly paths: RunPaths;
	readonly journal: Journal;
	step(event: Event): void;
	send(key: string, from: string, to: string, body: unknown, options?: { readonly replyTo?: string | undefined }): { ok: true; id: string } | { ok: false; reason: "invalid" | "closed"; errors: { path: string; message: string }[] };
	schemaOf(address: string): TSchema | undefined;
	planFor(def: AgentDef): SandboxPlan;
}

export interface AgentCallSpec {
	readonly host: AgentHost;
	readonly effect: Extract<Effect, { type: "call_agent" }>;
	readonly def: AgentDef;
	readonly input: Json;
	readonly slot: string;
	readonly label: string;
	readonly turns: number;
	readonly mailbox: LiveMailbox | null;
	readonly signal: AbortSignal;
}

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Thinking = (typeof THINKING)[number];

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

/** Provider errors worth retrying (rate limits, overload, 5xx, timeouts, the network); never auth, billing or a missing model. */
export function transientError(message: string): boolean {
	if (/\b(401|402|403|404|412)\b|billing|suspended|invalid api key|unauthori[sz]ed|forbidden|not found|unknown model|insufficient/i.test(message)) return false;
	return /\b(408|409|425|429|5\d\d)\b|overloaded|rate.?limit|too many requests|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network|fetch failed/i.test(message);
}

/** Default backoff for transient errors: 3 attempts after 5 s, 30 s and 2 min. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

const CHARS_PER_TOKEN = 3;
const KEEP_RECENT_TOKENS = 20_000;
const RESERVE = 0.2;
const MAX_INVALID = 3;

const SYSTEM = `Work only with the tools you are given. When you are done, call submit_result with a result that matches its schema; if it does not match, you get the errors and may submit again.`;
const WORKSPACE = "Your files: /w is your workspace (it carries over to the next call of this conversation; files from earlier calls may show read-only modes, and you can still write them); /in holds your input files and the files of messages you received (read-only); /tmp is empty again in every tool call.";

/** A checkpoint: the whole dialogue after a completed turn, and the turns used. */
interface Checkpoint {
	messages: AgentMessage[];
	turns: number;
	compacted: { summary: AgentMessage; replaces: number } | null;
}

const CheckpointShape = Type.Object({ messages: Type.Array(Type.Object({ role: Type.String() })), turns: Type.Integer({ minimum: 0 }) });

function loadCheckpoint(value: Json | undefined): Checkpoint | null {
	if (value === undefined || value === null || !Value.Check(CheckpointShape, value)) return null;
	const saved = value as unknown as Checkpoint;
	const messages = [...saved.messages];
	// A reply that failed or was cut off is not progress.
	while (messages.length > 0) {
		const last = messages.at(-1) as { role: string; stopReason?: string };
		if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) messages.pop();
		else break;
	}
	return { messages, turns: saved.turns, compacted: saved.compacted ?? null };
}

function textOf(m: AgentMessage | undefined): string {
	if (!m || m.role !== "assistant") return "";
	return m.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
}

/** Every message id an agent's dialogue already holds (deliveries are written as `[message <id> …]`). */
function takenIn(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		const text = typeof (m as { content?: unknown }).content === "string" ? ((m as { content: string }).content) : JSON.stringify((m as { content?: unknown }).content ?? "");
		for (const x of text.matchAll(/\[message ([^\]\s]+)/g)) ids.add(x[1]!);
	}
	return ids;
}

/** The output schema as the agent fills it: a file in the output is the path of a file (or dir) in /w. */
function submitSchema(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(submitSchema);
	const s = schema as Record<string, unknown>;
	if (s[MARK] === "artifact") return { type: "string", description: "the path of a file in /w" };
	if (s[MARK] === "tree") return { type: "string", description: "the path of a directory in /w" };
	return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, submitSchema(v)]));
}

export interface AgentRunnerOptions {
	readonly models: PiModels;
	readonly getApiKey?: ((provider: string) => string | undefined) | undefined;
	/** Model aliases from project configuration. */
	readonly aliases: Readonly<Record<string, string>>;
	readonly tools: ToolCaller;
	readonly retryDelaysMs?: readonly number[] | undefined;
}

export class AgentRunner {
	readonly #o: AgentRunnerOptions;

	constructor(options: AgentRunnerOptions) {
		this.#o = options;
	}

	/** Runs one agent call to its end; returns the event that settles it. Progress is stepped as it happens. */
	async run(spec: AgentCallSpec): Promise<Event[]> {
		const call = new AgentCall(spec, this.#o);
		try {
			return [await call.run()];
		} finally {
			await call.close();
		}
	}
}

type Settle = Extract<Event, { type: "agent_returned" | "agent_failed" }>;

class AgentCall {
	readonly #s: AgentCallSpec;
	readonly #o: AgentRunnerOptions;
	readonly #store: Store;
	#agent!: Agent;
	#model = "";
	#turns = 0;
	#limit: number;
	#limitHit = false;
	#interrupted = false;
	#exhausted = false;
	#invalid = 0;
	#invalidErrors: string[] = [];
	#submitted: Json | undefined;
	#compacted: Checkpoint["compacted"] = null;
	#history: { digest: string; state: Json } | null = null;
	readonly #connections: Connection[] = [];
	/** Refs the agent may read: its input's and those of every message it took. */
	readonly #refs: unknown[] = [];
	#work: Work | null = null;
	readonly #root: string;
	#system = "";

	constructor(spec: AgentCallSpec, options: AgentRunnerOptions) {
		this.#s = spec;
		this.#o = options;
		this.#store = spec.host.store;
		this.#limit = spec.turns;
		this.#root = join(spec.host.paths.work, `agent-${callDir(spec.slot, spec.effect.attempt)}`);
		this.#refs.push(spec.input);
	}

	async close(): Promise<void> {
		this.#agent?.abort();
		await Promise.all(this.#connections.map((c) => this.#o.tools.disconnect(c)));
	}

	#fail(failure: Extract<Event, { type: "agent_failed" }>["failure"], withDialogue: boolean): Settle {
		const dialogue = withDialogue ? this.#save(false) : null;
		return { type: "agent_failed", id: this.#s.effect.id, failure, model: this.#model, dialogue, layers: this.#commit() };
	}

	/** The workspace's layers after the call: its upper dir committed on top (squashed beyond 16). */
	#commit(): string[] {
		const before = this.#s.effect.layers;
		if (this.#work === null) return [...before];
		const committed = commitLayer(this.#store.dir, this.#work, this.#root, this.#s.effect.attempt);
		const after = layersAfter(this.#store.dir, before, committed);
		removeWork(this.#root);
		this.#work = null;
		return after;
	}

	/** The dialogue now, as a blob (a delta from the session's dialogue before the call); with `progress`, journaled as a checkpoint. */
	#save(progress: boolean): string {
		const data: Checkpoint = { messages: this.#agent.state.messages, turns: this.#turns, compacted: this.#compacted };
		const digest = putDialogue(this.#store, JSON.parse(JSON.stringify(data)) as Json, this.#history);
		if (progress) this.#s.host.step({ type: "agent_progressed", id: this.#s.effect.id, checkpoint: digest });
		return digest;
	}

	async run(): Promise<Settle> {
		const { effect, def } = this.#s;
		const alias = def.model;
		const resolved = this.#o.aliases[alias] ?? this.#o.aliases.default;
		if (!resolved) return this.#fail({ type: "gave_up", error: `model alias ${alias} is not configured (.wallis/config.json "models")` }, false);
		this.#model = resolved;
		let model: Model<string>;
		let thinking: Thinking | undefined;
		try {
			const p = parseModel(resolved);
			const m = this.#o.models.getModel(p.provider, p.id);
			if (!m) throw new Error(`unknown model ${resolved}`);
			model = m as Model<string>;
			thinking = p.thinking;
		} catch (error) {
			return this.#fail({ type: "gave_up", error: error instanceof Error ? error.message : String(error) }, false);
		}
		// The session's dialogue before this call, and this attempt's newest checkpoint.
		if (effect.history !== null) {
			const state = readDialogue(this.#store, effect.history);
			if (state !== undefined) this.#history = { digest: effect.history, state };
		}
		const saved = effect.checkpoint !== null ? loadCheckpoint(readDialogue(this.#store, effect.checkpoint)) : null;
		const before = saved ?? loadCheckpoint(this.#history?.state);
		this.#turns = saved?.turns ?? 0;
		this.#compacted = saved?.compacted ?? before?.compacted ?? null;
		if (def.workspace) {
			// A workspace's commits must tell opaque dirs from merged ones: refused up front without the tool.
			const missing = xattrToolsMissing();
			if (missing !== null) return this.#fail({ type: "gave_up", error: `${missing} is not installed (the attr package): an agent workspace needs it; install attr` }, false);
			const work = prepareWork(this.#store.dir, this.#root, effect.layers, effect.attempt);
			if ("missing" in work) return this.#fail({ type: "gave_up", error: `layer ${work.missing} of the session's workspace is not in the store` }, false);
			this.#work = work;
		}
		let tools: AgentTool[];
		try {
			tools = await this.#tools();
		} catch (error) {
			return this.#fail({ type: "gave_up", error: `tools: ${error instanceof Error ? error.message : String(error)}` }, false);
		}
		this.#system = `${SYSTEM}${def.workspace ? `\n${WORKSPACE}` : ""}\n\n${def.prompt}`;
		const streamFn = (this.#o.models.streamSimple as (...a: unknown[]) => never).bind(this.#o.models);
		this.#agent = new Agent({
			initialState: { systemPrompt: this.#system, model: model as never, thinkingLevel: thinking ?? "off", tools, messages: before?.messages ?? [] },
			streamFn,
			getApiKey: this.#o.getApiKey,
			toolExecution: "sequential",
			steeringMode: "all",
			finishTurn: async () => {
				if (this.#submitted !== undefined || this.#invalid >= MAX_INVALID) return { action: "end" };
				// Messages that arrived during this turn enter the next, together (after an abort, the
				// loop ends here and the next round takes them).
				if (!this.#interrupted && !this.#limitHit && !this.#exhausted && !this.#s.signal.aborted) this.#deliver();
				return undefined;
			},
			transformContext: (messages, signal) => this.#fit(messages, streamFn, signal).then((m) => this.#quota(m)),
		});
		this.#agent.subscribe((event) => {
			// Every rejected result counts, whether pi's argument check or ours rejected it.
			if (event.type === "tool_execution_end" && event.toolName === "submit_result" && event.isError) {
				this.#invalid++;
				const said = ((event.result as { content?: { text?: string }[] } | undefined)?.content ?? []).map((c) => c.text ?? "").join("\n");
				if (this.#invalidErrors.length === 0 || !said.includes("does not match the output schema")) this.#invalidErrors = said.split("\n").filter((l) => l.trim() !== "").slice(0, 12);
			}
			// A reply with tool calls is checkpointed before its tools run, so a crash inside the turn
			// resumes knowing which calls it made (a send among them is answered from the journal).
			if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "toolUse") this.#save(true);
			if (event.type !== "turn_end") return;
			const last = this.#agent.state.messages.at(-1);
			if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) return;
			this.#turns++;
			this.#save(true);
			if (this.#turns >= this.#limit && this.#submitted === undefined) {
				this.#limitHit = true;
				this.#agent.abort();
			}
		});
		this.#s.signal.addEventListener("abort", () => this.#agent.abort(), { once: true });
		if (this.#s.mailbox) {
			this.#s.mailbox.onMessage = (interrupt) => {
				if (interrupt && this.#agent.state.isStreaming) {
					this.#interrupted = true;
					this.#agent.abort();
				}
			};
		}

		// Where this attempt starts.
		let next: () => Promise<void>;
		const c = effect.continuation;
		if (saved !== null && c.type === "more_turns") {
			const more = c.turns > 0 ? c.turns : this.#s.turns;
			this.#limit = this.#turns + more;
			next = () => this.#agent.prompt(this.#user(`You have ${more} more turns. Continue where you left off, and submit your result when you are done.`));
		} else if (saved !== null && c.type === "fix_output") {
			this.#limit = this.#turns + this.#s.turns;
			next = () => this.#agent.prompt(this.#user(`Your result did not match the output schema:\n${c.errors.join("\n")}\nFix it and call submit_result again.`));
		} else if (saved !== null) {
			// A reissued call: continue from its last checkpoint. Tool calls a stop cut off: a send that was
			// journaled gets its result back (it is never sent twice); any other gets an error result.
			const last = saved.messages.at(-1);
			if (last?.role === "assistant") {
				const calls = last.content.filter((p) => p.type === "toolCall");
				for (const call of calls) {
					const sent = call.name === "send" ? this.#s.host.journal.core.sentId(this.#sendKey(call.id)) : "";
					const result =
						sent !== ""
							? { content: [{ type: "text", text: `sent: message id ${sent}` }], isError: false }
							: { content: [{ type: "text", text: `The run stopped while ${call.name} was running; it may or may not have taken effect. Check before relying on it.` }], isError: true };
					this.#agent.state.messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, ...result, timestamp: Date.now() } as never);
				}
				// The cut-off turn counts.
				if (calls.length > 0) this.#turns++;
				next = calls.length > 0 ? () => this.#agent.continue() : () => this.#idle();
			} else next = () => this.#agent.continue();
		} else {
			next = () => this.#agent.prompt(this.#user(this.#firstPrompt(before !== null)));
		}

		for (;;) {
			const failed = await this.#round(next);
			if (this.#s.signal.aborted) return this.#fail({ type: "gave_up", error: "stopped" }, false);
			if (this.#submitted !== undefined) return this.#returned();
			if (this.#invalid >= MAX_INVALID) return this.#fail({ type: "invalid_output", errors: this.#invalidErrors }, true);
			if (this.#exhausted) return this.#fail({ type: "context_exhausted" }, false);
			if (this.#limitHit) return this.#fail({ type: "turn_limit_reached", turns: this.#turns }, true);
			if (failed !== null && !this.#interrupted) return this.#fail({ type: "gave_up", error: failed }, false);
			if (this.#interrupted) {
				this.#interrupted = false;
				const msgs = this.#agent.state.messages;
				if (msgs.at(-1)?.role === "assistant") this.#agent.state.messages = msgs.slice(0, -1);
			}
			if (this.#turns >= this.#limit) return this.#fail({ type: "turn_limit_reached", turns: this.#turns }, true);
			next = () => this.#idle();
		}
	}

	/** The agent ended a turn without a result: with a mailbox it waits for the next message; without, it is reminded. */
	async #idle(): Promise<void> {
		const mailbox = this.#s.mailbox;
		if (mailbox === null) return this.#agent.prompt(this.#user("You ended your turn without a result. Call submit_result with your result."));
		// Wait for a message the dialogue does not hold yet: a resumed call's mailbox replays the
		// recorded ones, and those it already took are skipped.
		for (;;) {
			const waiting: CoreEnvelope[] = [];
			if (mailbox.pending === 0) {
				const first = await mailbox.next();
				if (first === null) return this.#agent.prompt(this.#user("Your mailbox is closed: no more messages will arrive. Call submit_result with your result now."));
				waiting.push(first);
			}
			const batch = this.#take([...waiting, ...mailbox.drain()]);
			if (batch !== null) return this.#agent.prompt(batch);
		}
	}

	/** Takes waiting messages into the next turn (a steering message while a turn runs). */
	#deliver(): void {
		const mailbox = this.#s.mailbox;
		if (mailbox === null || mailbox.pending === 0) return;
		const message = this.#take(mailbox.drain());
		if (message !== null) this.#agent.steer(message);
	}

	/** The user message that delivers these messages (skipping any the dialogue already holds), journaled as taken. */
	#take(envelopes: CoreEnvelope[]): AgentMessage | null {
		const all = envelopes;
		const known = takenIn(this.#agent.state.messages);
		const fresh = all.filter((e) => !known.has(e.id));
		if (fresh.length === 0) return null;
		this.#s.host.step({ type: "messages_taken", id: this.#s.effect.id, messages: fresh.map((e) => e.id), turn: this.#turns });
		for (const e of fresh) this.#refs.push(e.body);
		const text = fresh
			.map((e) => `[message ${e.id} from ${e.from}${e.reply_to !== null ? `, reply to ${e.reply_to}` : ""}]\n${JSON.stringify(withPaths(e.body, mountPoint))}`)
			.join("\n\n");
		return this.#user(`${fresh.length === 1 ? "A message arrived" : `${fresh.length} messages arrived`} in your mailbox:\n\n${text}`);
	}

	#user(text: string): AgentMessage {
		return { role: "user", content: text, timestamp: Date.now() } as never;
	}

	#firstPrompt(continuing: boolean): string {
		const sends = this.#sendTargets();
		const parts = [continuing ? "Your next input:" : "Your input:", JSON.stringify(withPaths(this.#s.input, mountPoint), null, 1)];
		if (sends.length > 0) parts.push(`You can send messages with \`send\` to: ${sends.map((s) => s.field).join(", ")}. Sending returns at once with the message's id; replies arrive in your mailbox with reply_to set to it.`);
		if (this.#s.def.mailbox) parts.push("Messages may arrive in your mailbox between turns. When you have nothing to do, end your turn: you wait for the next message.");
		return parts.join("\n\n");
	}

	/** A round of the agent loop, with backoff for transient provider errors. */
	async #round(start: () => Promise<void>): Promise<string | null> {
		const delays = this.#o.retryDelaysMs ?? RETRY_DELAYS_MS;
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
			if (error === null || this.#exhausted || this.#limitHit || this.#interrupted || this.#s.signal.aborted) return error;
			if (!transientError(error) || attempt >= delays.length) return error;
			await new Promise((r) => setTimeout(r, delays[attempt]));
			const msgs = this.#agent.state.messages;
			if (msgs.at(-1)?.role === "assistant") this.#agent.state.messages = msgs.slice(0, -1);
			start = () => this.#agent.continue();
		}
	}

	#returned(): Settle {
		const dialogue = this.#save(false);
		return { type: "agent_returned", id: this.#s.effect.id, output: this.#submitted!, model: this.#model, dialogue, layers: this.#commit() };
	}

	/** "Turn k of N" at the end of the newest message (never the system prompt, so its cached prefix stays stable). */
	#quota(messages: AgentMessage[]): AgentMessage[] {
		const last = messages.at(-1) as { role: string; content: unknown } | undefined;
		if (!last || (last.role !== "user" && last.role !== "toolResult")) return messages;
		const note = `\n\n[Turn ${this.#turns + 1} of ${this.#limit}]`;
		const QUOTA = /\n\n\[Turn \d+ of \d+\]$/;
		if (typeof last.content === "string") last.content = last.content.replace(QUOTA, "") + note;
		else if (Array.isArray(last.content)) {
			const parts = last.content as { type: string; text?: string }[];
			const tail = parts.at(-1);
			if (tail?.type === "text" && tail.text !== undefined) tail.text = tail.text.replace(QUOTA, "") + note;
			else parts.push({ type: "text", text: note.trimStart() });
		}
		return messages;
	}

	#tokens(messages: readonly AgentMessage[]): number {
		return (
			Math.ceil(this.#system.length / CHARS_PER_TOKEN) +
			messages.reduce((n, m) => {
				const { tokens, rest } = splitImages(m);
				return n + tokens + Math.max(estimateTokens(rest as AgentMessage), Math.ceil(JSON.stringify(rest).length / CHARS_PER_TOKEN));
			}, 0)
		);
	}

	/** Before each request: over the window, the older part of the dialogue is replaced by a summary. */
	async #fit(all: AgentMessage[], streamFn: (...a: unknown[]) => never, signal?: AbortSignal): Promise<AgentMessage[]> {
		const window = (this.#agent?.state.model as { contextWindow?: number } | undefined)?.contextWindow;
		const view = () => (this.#compacted ? [all[0]!, this.#compacted.summary, ...all.slice(this.#compacted.replaces)] : all);
		if (!window) return view();
		const budget = Math.floor(window * (1 - RESERVE));
		if (this.#tokens(view()) <= budget) return view();
		let cut = all.length;
		let kept = 0;
		const keep = Math.min(KEEP_RECENT_TOKENS, Math.floor(budget / 4));
		while (cut > 1 && kept + estimateTokens(all[cut - 1]!) <= keep) kept += estimateTokens(all[--cut]!);
		while (cut < all.length && all[cut]!.role === "toolResult") cut++;
		if (cut <= 1) return this.#exhaust(all);
		const model = this.#agent.state.model as never;
		const apiKey = await this.#o.getApiKey?.((model as { provider: string }).provider);
		const text = await generateSummary(all.slice(1, cut), model, undefined, apiKey, undefined, signal, undefined, undefined, undefined, streamFn);
		this.#compacted = { summary: { role: "user", content: `Summary of the earlier dialogue (compacted):\n${text}`, timestamp: Date.now() } as never, replaces: cut };
		if (this.#tokens(view()) > budget) return this.#exhaust(all);
		return view();
	}

	#exhaust(messages: AgentMessage[]): AgentMessage[] {
		this.#exhausted = true;
		this.#agent.abort();
		return messages;
	}

	// --- Tools ---------------------------------------------------------------------------

	/** A send's identity: (call, turn, the model's tool-call id). The journal delivers each key once. */
	#sendKey(toolCallId: string): string {
		return `${this.#s.slot}|t${this.#turns}|${toolCallId}`;
	}

	#sendTargets(): { field: string; id: string; message: TSchema }[] {
		return addressesIn(this.#s.def.input, this.#s.input).map((a) => ({ field: a.path.replace(/^\//, "").replace(/\//g, "."), id: a.id, message: a.message }));
	}

	async #tools(): Promise<AgentTool[]> {
		const tools: AgentTool[] = [this.#submitTool()];
		const sends = this.#sendTargets();
		if (sends.length > 0) tools.push(this.#sendTool(sends));
		const access = this.#s.def.workspace?.access;
		if (access) tools.push(...this.#fileTools(access));
		// Custom and MCP tools: one connection per source for this call.
		const bySource = new Map<string, { def: AgentDef["tools"][number]; remotes: (string | null)[] }>();
		for (const t of this.#s.def.tools) {
			const key = JSON.stringify(t.source.kind === "toolset" ? [t.source.file, t.source.sandbox.digest] : [t.source.server]);
			const entry = bySource.get(key) ?? { def: t, remotes: [] };
			entry.remotes.push(t.remote);
			bySource.set(key, entry);
		}
		for (const { def, remotes } of bySource.values()) {
			const c = await this.#o.tools.connect(def.source);
			this.#connections.push(c);
			const wanted = c.tools.filter((t) => remotes.includes(t.remote) || (remotes.includes(null) && t.annotations.readOnlyHint === true));
			for (const info of wanted) {
				tools.push({
					name: info.name,
					label: info.name,
					description: info.description,
					parameters: info.inputSchema as never,
					execute: async (_id, params) => {
						const r = (await c.client.callTool(info.remote, (params ?? {}) as Record<string, unknown>)) as { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
						type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
						const content: Part[] = (r.content ?? []).flatMap((p): Part[] => (p.type === "text" ? [{ type: "text", text: p.text ?? "" }] : p.type === "image" && p.data ? [{ type: "image", data: p.data, mimeType: p.mimeType ?? "image/png" }] : []));
						if (r.isError) throw new Error(content.map((p) => (p.type === "text" ? p.text : "")).join("\n") || "the tool failed");
						return { content, details: undefined };
					},
				});
			}
		}
		return tools;
	}

	#submitTool(): AgentTool {
		return {
			name: "submit_result",
			label: "submit_result",
			description: "Submit your result. It must match the schema; a file is the path of a file you wrote in /w.",
			parameters: Type.Object({ result: submitSchema(this.#s.def.output) as TSchema }) as never,
			execute: async (_id, params) => {
				const raw = (params as { result?: unknown }).result;
				let value: unknown;
				try {
					value = await this.#resolveFiles(this.#s.def.output, raw);
				} catch (error) {
					return this.#invalidResult([error instanceof Error ? error.message : String(error)]);
				}
				const json = toJson(value);
				const errors = json.ok ? errorText(schemaErrors(this.#s.def.output, stripPaths(json.value))) : [json.error];
				if (errors.length > 0) return this.#invalidResult(errors);
				this.#submitted = stripPaths((json as { value: Json }).value);
				return { content: [{ type: "text", text: "Result accepted." }], details: undefined };
			},
		};
	}

	#invalidResult(errors: string[]): never {
		this.#invalidErrors = errors;
		throw new Error(`Your result does not match the output schema:\n${errors.join("\n")}\nFix it and call submit_result again.`);
	}

	/** File positions of the output (paths in /w) as artifacts and Trees: stored from the call's workspace. */
	async #resolveFiles(schema: unknown, value: unknown): Promise<unknown> {
		const s = schema as Record<string, unknown>;
		if (s?.[MARK] === "artifact" || s?.[MARK] === "tree") {
			if (typeof value !== "string") return value;
			const rel = posix.normalize(value.replace(/^\/w\/?/, ""));
			if (rel.startsWith("..") || rel === "." || this.#work === null) throw new Error(`${value} is not in /w`);
			const dir = join(this.#s.host.paths.work, `out-${Math.random().toString(36).slice(2)}`);
			mkdirSync(dir, { recursive: true });
			const target = join(dir, posix.basename(rel));
			// Copied out through the sandbox's view of /w (the layers and the upper dir together).
			const r = await this.#inSandbox(["sh", "-c", 'cp -a -- "/w/$1" "/out/$2"', "sh", rel, posix.basename(rel)], { extra: dir });
			if (r.exit !== 0) throw new Error(`${value}: ${head(r.stderr) || "not found in /w"}`);
			if (s[MARK] === "artifact") {
				const media = (s.properties as Record<string, { const?: string }> | undefined)?.media?.const ?? guessMedia(rel);
				return { kind: "artifact", digest: this.#store.ingestFile(target, { move: true }), name: posix.basename(rel), media };
			}
			return { kind: "tree", digest: this.#store.snapshot(target, { move: true }) };
		}
		if (Array.isArray(value)) return Promise.all(value.map((v) => this.#resolveFiles(s?.items, v)));
		if (value !== null && typeof value === "object") {
			const props = (s?.properties ?? {}) as Record<string, unknown>;
			const extra = (s?.additionalProperties ?? Object.values((s?.patternProperties ?? {}) as object)[0]) as unknown;
			return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await this.#resolveFiles(props[k] ?? extra, v)])));
		}
		return value;
	}

	#sendTool(targets: { field: string; id: string; message: TSchema }[]): AgentTool {
		const messages = [...new Map(targets.map((t) => [JSON.stringify(t.message), t.message])).values()];
		return {
			name: "send",
			label: "send",
			description: `Send a message (never waits). To: ${targets.map((t) => t.field).join(", ")}. Returns the message's id; a reply arrives in your mailbox with reply_to set to it.`,
			parameters: Type.Object({
				to: Type.Union(targets.map((t) => Type.Literal(t.field))),
				message: messages.length === 1 ? messages[0]! : Type.Union(messages),
				reply_to: Type.Optional(Type.String({ description: "the id of the message this answers" })),
			}) as never,
			execute: async (toolCallId, params) => {
				const p = params as { to: string; message: unknown; reply_to?: string };
				const target = targets.find((t) => t.field === p.to);
				if (!target) throw new Error(`no address ${p.to}; you can send to: ${targets.map((t) => t.field).join(", ")}`);
				const r = this.#s.host.send(this.#sendKey(toolCallId), this.#s.effect.mailbox, target.id, p.message, { replyTo: p.reply_to });
				if (!r.ok && r.reason === "closed") throw new Error(`The message was rejected (nothing was sent): ${p.to} is closed (its call has ended); it reads no more messages.`);
				if (!r.ok) throw new Error(`The message was rejected (nothing was sent):\n${r.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}\nFix it and send again.`);
				crashPoint("agent-send");
				return { content: [{ type: "text", text: `sent: message id ${r.id}` }], details: undefined };
			},
		};
	}

	/** One process in the call's sandbox, over its current view. */
	#inSandbox(argv: string[], options: { stdin?: string; extra?: string } = {}) {
		const plan = this.#s.host.planFor(this.#s.def);
		const mounts = mountsOf(this.#store, this.#refs);
		const work = this.#work;
		const view = {
			work: work === null ? { kind: "dir" as const, dir: this.#root } : work.lowers.length > 0 ? { kind: "overlay" as const, lowers: work.lowers, upper: work.upper, ovl: work.ovl } : { kind: "dir" as const, dir: work.upper },
			inputs: mounts.inputs,
			trees: mounts.trees,
			agent: true,
			writeLowers: this.#s.def.workspace?.access === "write" || this.#s.def.workspace?.access === "exec",
		};
		const sp = sandboxed(options.extra ? { ...plan, volumes: [...plan.volumes, { kind: "named", target: "/out", dir: options.extra, name: "out" }] } : plan, argv, view, { root: this.#s.host.paths.dir });
		// Writes to /out (an export of a result file) are the host's, not the agent's.
		if (options.extra) {
			const i = sp.args.indexOf("/out");
			if (i > 0 && sp.args[i - 2] === "--ro-bind") (sp.args as string[])[i - 2] = "--bind";
		}
		return runSpawn(sp, options.stdin ?? "", { signal: this.#s.signal });
	}

	#fileTools(access: "read" | "write" | "exec"): AgentTool[] {
		const abs = (p: string) => (p.startsWith("/") ? p : posix.join("/w", p));
		const run = async (argv: string[], stdin?: string) => {
			const r = await this.#inSandbox(argv, stdin === undefined ? {} : { stdin });
			if (r.exit !== 0) throw new Error(head(r.stderr || r.stdout) || `exit ${r.exit}`);
			return r.stdout;
		};
		const tools: AgentTool[] = [
			{
				name: "read",
				label: "read",
				description: "Read a file (text, or an image you can look at). Relative paths are in /w.",
				parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) }) as never,
				execute: async (_id, params) => {
					const p = params as { path: string; offset?: number; limit?: number };
					const data = Buffer.from((await run(["sh", "-c", 'base64 -w0 -- "$1"', "sh", abs(p.path)])).trim(), "base64");
					const image = /\.(png|jpe?g|gif|webp)$/i.exec(p.path);
					if (image) {
						const ext = image[1]!.toLowerCase();
						return { content: [{ type: "image", data: data.toString("base64"), mimeType: `image/${ext === "jpg" ? "jpeg" : ext}` }], details: undefined };
					}
					const lines = data.toString("utf8").split("\n");
					const from = (p.offset ?? 1) - 1;
					const slice = lines.slice(from, p.limit ? from + p.limit : undefined);
					return { content: [{ type: "text", text: slice.join("\n").slice(0, 100_000) }], details: undefined };
				},
			},
			{
				name: "ls",
				label: "ls",
				description: "List a directory (default /w).",
				parameters: Type.Object({ path: Type.Optional(Type.String()) }) as never,
				execute: async (_id, params) => ({ content: [{ type: "text", text: await run(["ls", "-la", "--", abs((params as { path?: string }).path ?? "/w")]) }], details: undefined }),
			},
		];
		if (access === "write" || access === "exec") {
			tools.push(
				{
					name: "write",
					label: "write",
					description: "Write a file in /w (creates its directories).",
					parameters: Type.Object({ path: Type.String(), content: Type.String() }) as never,
					execute: async (_id, params) => {
						const p = params as { path: string; content: string };
						// A file from an earlier call is read-only in its layer: made writable (copied up into this call's layer) first.
						await run(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && { [ ! -e "$1" ] || chmod u+w -- "$1"; } && cat > "$1"', "sh", abs(p.path)], p.content);
						return { content: [{ type: "text", text: `wrote ${abs(p.path)}` }], details: undefined };
					},
				},
				{
					name: "edit",
					label: "edit",
					description: "Replace one exact occurrence of `old` with `new` in a file in /w.",
					parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String() }) as never,
					execute: async (_id, params) => {
						const p = params as { path: string; old: string; new: string };
						const text = await run(["cat", "--", abs(p.path)]);
						const at = text.indexOf(p.old);
						if (at < 0 || text.indexOf(p.old, at + 1) >= 0) throw new Error(at < 0 ? "`old` is not in the file" : "`old` occurs more than once");
						await run(["sh", "-c", 'chmod u+w -- "$1" && cat > "$1"', "sh", abs(p.path)], text.slice(0, at) + p.new + text.slice(at + p.old.length));
						return { content: [{ type: "text", text: `edited ${abs(p.path)}` }], details: undefined };
					},
				},
			);
		}
		if (access === "exec") {
			tools.push({
				name: "bash",
				label: "bash",
				description: "Run a shell command in /w (no network).",
				parameters: Type.Object({ command: Type.String() }) as never,
				execute: async (_id, params) => {
					const r = await this.#inSandbox(["sh", "-c", (params as { command: string }).command]);
					const text = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}\n[exit ${r.exit}]`;
					return { content: [{ type: "text", text: text.slice(-50_000) }], details: undefined };
				},
			});
		}
		return tools;
	}
}
