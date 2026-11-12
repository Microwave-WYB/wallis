// The body runtime: one process driving one run. The workflow body is plain
// Node code; its wallis operations (`ctx`) become events for the core, and
// the core's effects are executed here: commands, tools, nested workflows,
// agent calls, message deliveries. The journal (core + log) decides what
// runs and what is answered from the record (docs/v2.md §5.3).
//
// Scopes. Every body, nested workflow and actor has a scope: the core's key
// prefix for its calls (a nested workflow's is its call's slot; an actor's
// its parent's plus `|actor<k>`), a request id prefix (deterministic for a
// deterministic body, so a resumed run's log matches an uninterrupted one),
// and per-(node, input) occurrence counters.
//
// Addresses. An actor is `actor:<scope>`, a running agent call
// `agent:<slot>`, a workflow body with a mailbox `wf:<scope>`, an outbox
// `outbox:<name>`, the caller `caller`. Each mailbox has a schema; every
// message is validated against the recipient's before it is journaled.

import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import Type, { type Static, type TSchema } from "typebox";
import type { AgentHost, AgentRunner } from "./agents.ts";
import { runCommand } from "./commands.ts";
import { type CallId, type CallRef, type FailureReason, MessageRejected, NodeFailed, publicReason, type SessionValue } from "./errors.ts";
import type { Effect, Envelope as CoreEnvelope, Event, FailReason, Json, Request } from "./host/core.ts";
import { slotText } from "./host/core.ts";
import type { Journal } from "./host/journal.ts";
import { callDir, type RunPaths } from "./host/runs.ts";
import { type SandboxPlan } from "./host/sandbox.ts";
import { squash } from "./host/layers.ts";
import type { Store } from "./host/store.ts";
import {
	agentDef, type Agent, type AgentDef, commandDef, type Command, DEF, definitionSite, isNode, type Session, type SessionData, sessionAgent, sessionValue, type Tool, toolDef, type ToolDef, type WorkflowDef, workflowDef,
} from "./nodes.ts";
import type { Plans } from "./plans.ts";
import type { ToolCaller } from "./toolcalls.ts";
import { type Address, addressesIn, canonical, type MessageId, schemaDigest, schemaErrors, sha256, stripPaths, toJson, type TreeRef, withPaths } from "./values.ts";

// --- Public body types ----------------------------------------------------------------

/** What a mailbox yields. `from` is the sender's own address, so a server replies without wiring. */
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

export interface Running<R, M = never> {
	/** Reaches the running call's mailbox (agents and workflows that declare one, actors). */
	readonly address: Address<M>;
	readonly result: Promise<R>;
}

export type Step<S, O> = { readonly next: S } | { readonly done: O };

export interface Workflow<IS extends TSchema = TSchema, OS extends TSchema = TSchema, M = never> {
	readonly kind: "workflow";
	readonly input: IS;
	readonly output: OS;
	__mailbox?(m: M): void;
}

type Out<N> = N extends Agent<any, infer O, any>
	? O
	: N extends Command<any, infer O>
		? O
		: N extends Tool<any, infer O>
			? O
			: N extends Workflow<any, infer OS>
				? Static<OS>
				: N extends Session<any, infer O, infer M>
					? readonly [O, Session<InOf<N>, O, M>]
					: never;
type InOf<N> = N extends Agent<infer I, any, any>
	? I
	: N extends Command<infer I, any>
		? I
		: N extends Tool<infer I, any>
			? I
			: N extends Workflow<infer IS, any>
				? Static<IS>
				: N extends Session<infer I, any, any>
					? I
					: never;
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

// --- Mailboxes ---------------------------------------------------------------------------

/** A live mailbox: the journaled messages first (in their recorded order), then new ones as they are delivered. */
export class LiveMailbox implements Mailbox<unknown> {
	readonly address: string;
	readonly #queue: CoreEnvelope[] = [];
	readonly #seen = new Set<string>();
	#waiters: ((e: CoreEnvelope | null) => void)[] = [];
	#closed = false;
	readonly #view: (e: CoreEnvelope) => Envelope<unknown>;
	/** Called when a message arrives (an agent's turn loop listens). */
	onMessage: ((interrupt: boolean) => void) | null = null;

	constructor(address: string, recorded: readonly CoreEnvelope[], view: (e: CoreEnvelope) => Envelope<unknown>) {
		this.address = address;
		this.#view = view;
		for (const e of recorded) this.push(e, false);
	}

	push(e: CoreEnvelope, interrupt: boolean): void {
		if (this.#seen.has(e.id) || this.#closed) return;
		this.#seen.add(e.id);
		const w = this.#waiters.shift();
		if (w) w(e);
		else this.#queue.push(e);
		this.onMessage?.(interrupt);
	}

	/** Every message now waiting, taken (an agent's batch). */
	drain(): CoreEnvelope[] {
		return this.#queue.splice(0);
	}

	get pending(): number {
		return this.#queue.length;
	}

	/** The next raw message, or null once closed and empty. */
	next(): Promise<CoreEnvelope | null> {
		const e = this.#queue.shift();
		if (e) return Promise.resolve(e);
		if (this.#closed) return Promise.resolve(null);
		return new Promise((done) => this.#waiters.push(done));
	}

	async receive(): Promise<Envelope<unknown> | { readonly closed: true }> {
		const e = await this.next();
		return e === null ? { closed: true } : this.#view(e);
	}

	get closed(): boolean {
		return this.#closed;
	}

	close(): void {
		this.#closed = true;
		for (const w of this.#waiters.splice(0)) w(null);
	}

	async *[Symbol.asyncIterator](): AsyncIterator<Envelope<unknown>> {
		for (;;) {
			const e = await this.next();
			if (e === null) return;
			yield this.#view(e);
		}
	}
}

// --- Scopes --------------------------------------------------------------------------------

class Scope {
	readonly scope: string;
	readonly prefix: string;
	/** The labels of the enclosing calls, outermost first. */
	readonly path: readonly string[];
	readonly self: string;
	seq = 0;
	spawns = 0;
	loops = 0;
	readonly occurrences = new Map<string, number>();
	readonly sends = new Map<string, number>();
	/** Actors spawned here: their mailboxes close when this body returns. */
	readonly children: LiveMailbox[] = [];
	/** Rejects when an actor spawned here fails and nobody handles its `result`: the body fails with it. */
	readonly failure: Promise<never>;
	fail!: (error: unknown) => void;
	/** The body returned or failed: it makes no more calls. */
	dead = false;

	constructor(scope: string, prefix: string, path: readonly string[], self: string) {
		this.scope = scope;
		this.prefix = prefix;
		this.path = path;
		this.self = self;
		this.failure = new Promise<never>((_, reject) => (this.fail = reject));
		this.failure.catch(() => {});
	}

	occurrence(key: string): number {
		const n = this.occurrences.get(key) ?? 0;
		this.occurrences.set(key, n + 1);
		return n;
	}
}

type Pending = {
	readonly kind: "command" | "workflow" | "agent" | "tool";
	readonly label: string;
	readonly path: readonly string[];
	readonly slot: string;
	readonly input: Json;
	readonly done: (value: Json) => void;
	readonly fail: (reason: FailReason) => void;
	readonly refuse: (message: string) => void;
	readonly command?: ReturnType<typeof commandDef>;
	readonly workflow?: WorkflowDef;
	readonly agent?: AgentDef;
	readonly tool?: ToolDef;
	readonly turns?: number;
	readonly session?: SessionData;
	readonly scopeOf?: Scope;
};

export type Outcome = { readonly type: "done"; readonly output: Json } | { readonly type: "failed"; readonly reason: FailReason };

/**
 * Whether a recipient has ended, for this process generation (`epoch`, noted at every start and
 * resume): an agent call that answered or failed decided (an errored one runs again on resume and
 * reads its mailbox then); an actor or body whose live mailbox closed, or that was noted closed in
 * this epoch (a resume reopens what an earlier process closed).
 */
export function isClosed(core: { callState(slot: string): string; facts(): Record<string, unknown> }, address: string, live?: { readonly closed: boolean }): boolean {
	if (address.startsWith("agent:")) return ["answered", "decided"].includes(core.callState(address.slice("agent:".length)));
	if (address.startsWith("actor:") || address.startsWith("wf:")) {
		if (live) return live.closed;
		const facts = core.facts();
		return facts[`closed:${address}`] !== undefined && facts[`closed:${address}`] === (facts.epoch ?? 1);
	}
	return false;
}

/** A NodeFailed's core reason (kept beside it, so a nested workflow fails with its leaf's reason). */
const CORE_REASON = new WeakMap<object, FailReason>();

/** An actor that failed with nobody handling its `result`: its spawning body fails with this. */
export class ActorFailed extends Error {
	override readonly name = "ActorFailed";
	readonly label: string;
	override readonly cause: unknown;
	constructor(label: string, cause: unknown) {
		super(`actor ${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.label = label;
		this.cause = cause;
	}
}

/**
 * An actor's `result`: it records whether anyone handles it (awaits it, or attaches then/catch),
 * which decides whether a failure goes to the result's handler or to the spawning body.
 */
class ActorResult<T> extends Promise<T> {
	handled = false;
	static override get [Symbol.species](): PromiseConstructor {
		return Promise;
	}
	override then<A = T, B = never>(onFulfilled?: ((v: T) => A | PromiseLike<A>) | null, onRejected?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
		this.handled = true;
		return super.then(onFulfilled, onRejected);
	}
}

export function coreReasonOf(error: unknown): FailReason {
	if (error !== null && typeof error === "object" && CORE_REASON.has(error)) return CORE_REASON.get(error)!;
	if (error instanceof MessageRejected) return { type: "body_error", message: error.message };
	return { type: "body_error", message: error instanceof Error ? error.message : String(error) };
}

export interface SessionOptions {
	readonly journal: Journal;
	readonly store: Store;
	readonly paths: RunPaths;
	readonly root: string;
	readonly workflow: WorkflowDef;
	readonly plans: Plans;
	readonly tools: ToolCaller;
	readonly agents: AgentRunner;
}

/** One process driving one run. */
export class RunSession implements AgentHost {
	readonly journal: Journal;
	readonly store: Store;
	readonly paths: RunPaths;
	readonly root: string;
	readonly plans: Plans;
	readonly #workflow: WorkflowDef;
	readonly #tools: ToolCaller;
	readonly #agents: AgentRunner;
	readonly #pending = new Map<string, Pending>();
	readonly #mailboxes = new Map<string, LiveMailbox>();
	readonly #schemas = new Map<string, TSchema>();
	readonly #aborts = new Set<AbortController>();
	#finished: ((o: Outcome) => void) | null = null;
	#ended = false;
	readonly result: Promise<Outcome>;

	constructor(options: SessionOptions) {
		this.journal = options.journal;
		this.store = options.store;
		this.paths = options.paths;
		this.root = options.root;
		this.plans = options.plans;
		this.#workflow = options.workflow;
		this.#tools = options.tools;
		this.#agents = options.agents;
		this.result = new Promise((done) => (this.#finished = done));
		this.#schemas.set("caller", Type.Unknown());
	}

	get ended(): boolean {
		return this.#ended;
	}

	// --- Steps and effects ------------------------------------------------------------

	/** Applies an event and executes its effects. After the run ended, late results are dropped (nothing waits for them). */
	step(event: Event): void {
		if (this.#ended) return;
		this.#effects(this.journal.step(event));
	}

	#effects(effects: readonly Effect[]): void {
		for (const e of effects) {
			switch (e.type) {
				case "checkpoint":
					break;
				case "deliver":
					this.#take(e.id)?.done(e.value);
					break;
				case "fail":
					this.#take(e.id)?.fail(e.reason);
					break;
				case "refuse":
					if (e.id !== null) this.#take(e.id)?.refuse(`the core refused this call: ${JSON.stringify(e.refusal)}`);
					else if (e.refusal.type !== "run_ended") throw new Error(`the core refused an event: ${JSON.stringify(e.refusal)}`);
					break;
				case "run_command":
					this.#runCommand(e.id, e.attempt);
					break;
				case "run_tool":
					this.#runTool(e.id);
					break;
				case "run_workflow":
					this.#runWorkflow(e.id, e.scope);
					break;
				case "call_agent":
					this.#callAgent(e);
					break;
				case "delivered":
					this.#mailboxes.get(e.mailbox)?.push(e.message, this.#interrupts.delete(e.message.id));
					break;
				case "finish":
					this.#end(e.outcome.type === "done" ? { type: "done", output: e.outcome.value } : { type: "failed", reason: e.outcome.reason });
					break;
			}
		}
	}

	readonly #interrupts = new Set<string>();

	#take(id: string): Pending | undefined {
		const p = this.#pending.get(id);
		this.#pending.delete(id);
		return p;
	}

	#end(outcome: Outcome): void {
		if (this.#ended) return;
		this.#ended = true;
		for (const a of this.#aborts) a.abort();
		for (const m of this.#mailboxes.values()) m.close();
		this.journal.step({ type: "noted", key: "ended_at", value: new Date().toISOString() });
		void this.#tools.close();
		this.#finished?.(outcome);
	}

	/** Stops in-flight work (a stop or a signal): nothing more is logged. */
	abort(): void {
		this.#ended = true;
		for (const a of this.#aborts) a.abort();
		void this.#tools.close();
	}

	#signal(): AbortController {
		const a = new AbortController();
		this.#aborts.add(a);
		return a;
	}

	#runCommand(id: string, attempt: number): void {
		const p = this.#pending.get(id);
		if (!p?.command) return;
		const abort = this.#signal();
		void runCommand({ store: this.store, work: join(this.paths.work, callDir(p.slot, attempt)), def: p.command, input: p.input, plan: () => this.plans.plan(p.command!.sandbox), signal: abort.signal })
			.then((r) => this.step(r.type === "returned" ? { type: "command_returned", id, output: r.output } : { type: "command_failed", id, failure: r.failure }))
			.catch((error) => this.#crash(error))
			.finally(() => this.#aborts.delete(abort));
	}

	#runTool(id: string): void {
		const p = this.#pending.get(id);
		if (!p?.tool) return;
		void this.#tools
			.call(p.tool, p.input)
			.then((r) => this.step(r.ok ? { type: "tool_returned", id, output: r.output } : { type: "tool_failed", id, message: r.message }))
			.catch((error) => this.step({ type: "tool_failed", id, message: error instanceof Error ? error.message : String(error) }));
	}

	#runWorkflow(id: string, scope: string): void {
		const p = this.#pending.get(id);
		if (!p?.workflow) return;
		const parent = p.scopeOf!;
		const wf = p.workflow;
		const child = new Scope(scope, `${id}.`, [...parent.path, p.label], `wf:${scope}`);
		void this.#body(wf, child, p.input)
			.then((output) => this.step({ type: "workflow_returned", id, output }))
			.catch((error) => this.step({ type: "workflow_failed", id, reason: coreReasonOf(error) }));
	}

	#callAgent(e: Extract<Effect, { type: "call_agent" }>): void {
		const p = this.#pending.get(e.id);
		if (!p?.agent) return;
		const mailbox = p.agent.mailbox ? this.#mailbox(e.mailbox, p.agent.mailbox) : null;
		const abort = this.#signal();
		void this.#agents
			.run({ host: this, effect: e, def: p.agent, input: p.input, slot: p.slot, label: p.label, turns: p.turns ?? p.agent.turns, mailbox, signal: abort.signal })
			.then((events) => {
				for (const ev of events) {
					if (ev.type === "agent_failed" && ev.layers.length > 0) this.#failedLayers.set(ev.id, ev.layers);
					this.step(ev);
				}
			})
			.catch((error) => this.#crash(error))
			.finally(() => {
				this.#aborts.delete(abort);
				mailbox?.close();
				this.#mailboxes.delete(e.mailbox);
			});
	}

	/** A bug in wallis itself (not in a call): the run process stops; resume continues it. */
	#crash(error: unknown): void {
		if (this.#ended) return;
		process.stderr.write(`wallis: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		this.abort();
		this.#finished?.({ type: "failed", reason: { type: "body_error", message: `wallis internal error: ${error instanceof Error ? error.message : String(error)}` } });
	}

	// --- Mailboxes and messages ----------------------------------------------------------

	#envelope(e: CoreEnvelope): Envelope<unknown> {
		return { id: e.id as MessageId, from: { kind: "address", id: e.from }, ...(e.reply_to !== null ? { replyTo: e.reply_to as MessageId } : {}), body: this.hostView(e.body) };
	}

	#mailbox(address: string, schema: TSchema): LiveMailbox {
		this.#schemas.set(address, schema);
		let m = this.#mailboxes.get(address);
		if (!m) {
			m = new LiveMailbox(address, this.journal.core.mailbox(address), (e) => this.#envelope(e));
			this.#mailboxes.set(address, m);
		}
		return m;
	}

	schemaOf(address: string): TSchema | undefined {
		return this.#schemas.get(address);
	}

	/**
	 * Whether a recipient has ended: an agent call that settled (the journal says), an actor or
	 * workflow body that returned (its live mailbox, else the fact noted when it closed).
	 */
	closed(address: string): boolean {
		return isClosed(this.journal.core, address, this.#mailboxes.get(address));
	}

	/** An actor's or body's mailbox closed: noted with this process's epoch, so a caller (another process) knows it too. */
	#closedNote(address: string): void {
		const epoch = this.journal.core.facts().epoch ?? 1;
		if (this.#ended || this.journal.core.facts()[`closed:${address}`] === epoch) return;
		this.step({ type: "noted", key: `closed:${address}`, value: epoch });
	}

	/**
	 * Sends a message: validated against the recipient's schema, then journaled
	 * once by `key`. Returns its id, or the validation errors (nothing was sent).
	 */
	send(key: string, from: string, to: string, body: unknown, options: { readonly replyTo?: string | undefined; readonly interrupt?: boolean | undefined } = {}): { ok: true; id: MessageId } | { ok: false; reason: "invalid" | "closed"; errors: { path: string; message: string }[] } {
		const known = this.journal.core.sentId(key);
		if (known !== "") return { ok: true, id: known as MessageId };
		if (this.closed(to)) return { ok: false, reason: "closed", errors: [{ path: "/", message: `${to} is closed: it has ended and reads no more messages` }] };
		const schema = this.#schemas.get(to);
		if (schema === undefined) return { ok: false, reason: "invalid", errors: [{ path: "/", message: `no mailbox at ${to} in this run (it is not running, or it has none)` }] };
		const json = toJson(body);
		if (!json.ok) return { ok: false, reason: "invalid", errors: [{ path: "/", message: json.error }] };
		const value = stripPaths(json.value);
		const errors = schemaErrors(schema, value);
		if (errors.length > 0) return { ok: false, reason: "invalid", errors };
		// The id is assigned by the core when it journals the send; an interrupt goes with its delivery.
		const effects = this.journal.step({ type: "sent", key, to, from, reply_to: options.replyTo ?? null, body: value });
		const id = this.journal.core.sentId(key);
		if (options.interrupt) this.#interrupts.add(id);
		this.#effects(effects);
		return { ok: true, id: id as MessageId };
	}

	/** Delivers what the caller sent (`run.send`): by name, through the run's inbox file. */
	applyInbox(): void {
		const file = join(this.paths.dir, "inbox.jsonl");
		if (this.#ended) return;
		// New complete lines since the last read: parsed once, then kept until they can be delivered.
		if (existsSync(file) && statSync(file).size > this.#inboxAt) {
			const fd = openSync(file, "r");
			try {
				const size = fstatSync(fd).size;
				const buf = Buffer.alloc(size - this.#inboxAt);
				readSync(fd, buf, 0, buf.length, this.#inboxAt);
				const text = buf.toString("utf8");
				const end = text.lastIndexOf("\n") + 1;
				this.#inboxAt += Buffer.byteLength(text.slice(0, end));
				for (const line of text.slice(0, end).split("\n")) {
					if (!line) continue;
					let entry: unknown;
					try {
						entry = JSON.parse(line);
					} catch {
						continue;
					}
					if (entry === null || typeof entry !== "object") continue;
					const { key, name, body, replyTo, interrupt } = entry as { key?: unknown; name?: unknown; body?: unknown; replyTo?: unknown; interrupt?: unknown };
					if (typeof key !== "string" || typeof name !== "string") continue;
					this.#inbox.push({ key, name, body, replyTo: typeof replyTo === "string" ? replyTo : undefined, interrupt: interrupt === true });
				}
			} finally {
				closeSync(fd);
			}
		}
		if (this.#inbox.length === 0) return;
		const facts = this.journal.core.facts();
		this.#inbox = this.#inbox.filter((e) => {
			if (this.journal.core.sentId(e.key) !== "") return false;
			const registered = facts[`registered:${e.name}`] as { address?: string } | undefined;
			// Not deliverable yet (the resumed body has not re-created its recipient): kept for later.
			if (!registered?.address || !this.#schemas.has(registered.address)) return true;
			const r = this.send(e.key, "caller", registered.address, e.body, { replyTo: e.replyTo, interrupt: e.interrupt });
			// Told to the caller (run.send waits for its message's id or for this).
			if (!r.ok) appendFileSync(join(this.paths.dir, "inbox.rejected.jsonl"), `${JSON.stringify({ key: e.key, reason: r.reason, errors: r.errors })}\n`);
			return false;
		});
	}
	#inboxAt = 0;
	#inbox: { key: string; name: string; body: unknown; replyTo: string | undefined; interrupt: boolean }[] = [];

	/** A value as bodies and callers see it: every ref with its host path in the store. */
	hostView(value: Json): unknown {
		return withPaths(value, (r) => (r.kind === "artifact" ? this.store.blobPath(r.digest) : this.treePath(r.digest)));
	}

	treePath(digest: string): string {
		const layers = this.store.treeLayers(digest);
		return layers === null || layers.length === 0 ? "" : this.store.layerDir(layers.at(-1)!);
	}

	// --- Bodies ------------------------------------------------------------------------

	/** Runs the top workflow's body. */
	start(input: Json): void {
		const top = new Scope("", "", [], "wf:");
		void this.#body(this.#workflow, top, input)
			.then((output) => this.step({ type: "body_finished", output }))
			.catch((error) => this.step({ type: "body_failed", reason: coreReasonOf(error) }));
	}

	async #body(wf: WorkflowDef, scope: Scope, input: Json): Promise<Json> {
		const mailbox = wf.mailbox ? this.#mailbox(scope.self, wf.mailbox) : new LiveMailbox(scope.self, [], (e) => this.#envelope(e));
		if (!wf.mailbox) mailbox.close();
		const ctx = this.#ctx(scope);
		try {
			// An actor failing unhandled fails this body, as an unhandled rejection would.
			const out = await Promise.race([(wf.run as (c: unknown, i: unknown, m: unknown) => Promise<unknown>)(ctx, this.hostView(input), mailbox), scope.failure]);
			const json = toJson(out);
			if (!json.ok) throw this.#nodeFailed(this.#ref(scope.scope, wf.label, scope.path, 1), { type: "schema_mismatch", node: wf.label, errors: [json.error] });
			const value = stripPaths(json.value);
			const errors = schemaErrors(wf.output, value);
			if (errors.length > 0) throw this.#nodeFailed(this.#ref(scope.scope, wf.label, scope.path, 1), { type: "schema_mismatch", node: wf.label, errors: errors.map((e) => `${e.path} ${e.message}`) });
			return value;
		} finally {
			scope.dead = true;
			for (const m of scope.children) m.close();
			mailbox.close();
			if (wf.mailbox) this.#closedNote(scope.self);
		}
	}

	#ref(slot: string, label: string, path: readonly string[], attempt: number): CallRef {
		return { id: slot as CallId, label, path, attempt };
	}

	#nodeFailed(call: CallRef, reason: FailReason): NodeFailed {
		const e = new NodeFailed(call, publicReason(reason, (id) => this.#sessionOf(id)));
		CORE_REASON.set(e, reason);
		return e;
	}

	/** A session value from its id (a failure carries one): the core's journal knows its agent and layers via the call that answered with it. */
	#sessionOf(id: string): SessionValue {
		return this.#sessionIndex.get(id) ?? { kind: "session", agent: "", id, layers: [] };
	}
	readonly #sessionIndex = new Map<string, SessionValue>();

	#ctx(scope: Scope): Ctx<unknown> {
		const session = this;
		const ctx: Ctx<unknown> = {
			call: (node, input, options) => session.#start(scope, node, input, options).result as never,
			start: (node, input, options) => session.#start(scope, node, input, options) as never,
			session: (agent, options) => {
				const def = agentDef(agent);
				const layers = options?.from ? (session.store.treeLayers(options.from.digest) ?? []) : [];
				return sessionValue(def, null, layers) as never;
			},
			files: (s) => {
				const data = s as unknown as SessionData;
				let layers = [...data.layers];
				if (layers.length > 1) layers = [squash(session.store.dir, layers)];
				const digest = session.store.putTree(layers);
				return { kind: "tree", digest, path: session.treePath(digest) };
			},
			spawn: (schema, body) => session.#spawn(scope, schema, body as never, definitionSite("actor").label) as never,
			map: (items, f) => Promise.all(items.map((item, i) => session.#spawn(scope, Type.Never(), (c) => f(c as unknown as Ctx, item, i), `map item ${i}`).result)),
			loop: async (init, step) => {
				const k = scope.loops++;
				let state = init;
				for (let i = 0; ; i++) {
					const branch = new Scope(`${scope.scope}|loop${k}#${i}`, `${scope.prefix}l${k}.${i}.`, scope.path, scope.self);
					let r: Awaited<ReturnType<typeof step>>;
					try {
						r = await Promise.race([step(session.#ctx(branch) as unknown as Ctx, state), branch.failure]);
					} finally {
						// The iteration's actors close when its branch returns.
						branch.dead = true;
						for (const m of branch.children) m.close();
					}
					if ("done" in r) return r.done;
					state = r.next;
				}
			},
			send: (to, body, options) => {
				const sig = sha256(canonical({ to: to.id, body: toJson(body).ok ? stripPaths(body) : null, replyTo: options?.replyTo ?? null }));
				const n = scope.sends.get(sig) ?? 0;
				scope.sends.set(sig, n + 1);
				const r = session.send(`${scope.scope}|send|${sig}#${n}`, scope.self, to.id, body, options);
				if (!r.ok) throw new MessageRejected(to, r.errors, r.reason);
				return r.id;
			},
			self: { kind: "address", id: scope.self },
			register: (name, address) => {
				const schema = session.#schemas.get(address.id);
				if (schema === undefined) throw new Error(`register ${name}: ${address.id} has no mailbox in this run`);
				session.#note(`registered:${name}`, { address: address.id, schema: JSON.parse(JSON.stringify(schema)) as Json });
			},
			outbox: (name, message) => {
				const id = `outbox:${name}`;
				session.#schemas.set(id, message);
				session.#note(id, JSON.parse(JSON.stringify(message)) as Json);
				return { kind: "address", id } as never;
			},
		};
		return ctx;
	}

	/** Notes a host fact once (a resumed body registering again logs nothing). */
	#note(key: string, value: Json): void {
		if (canonical(this.journal.core.facts()[key] ?? null) === canonical(value)) return;
		this.step({ type: "noted", key, value });
	}

	#spawn<R>(scope: Scope, schema: TSchema, body: (ctx: Ctx<unknown>, mailbox: Mailbox<unknown>) => Promise<R>, label: string): Running<R, unknown> {
		const k = scope.spawns++;
		const actorScope = `${scope.scope}|actor${k}`;
		const address = `actor:${actorScope}`;
		const mailbox = this.#mailbox(address, schema);
		scope.children.push(mailbox);
		const child = new Scope(actorScope, `${scope.prefix}a${k}.`, scope.path, address);
		const inner = (async () => {
			try {
				// Its own unhandled actors fail it in turn.
				return await Promise.race([body(this.#ctx(child), mailbox), child.failure]);
			} finally {
				// A failed actor's mailbox closes too: later sends are rejected as closed.
				child.dead = true;
				for (const m of child.children) m.close();
				mailbox.close();
				this.#closedNote(address);
			}
		})();
		const result = new ActorResult<R>((resolve, reject) => {
			inner.then(resolve, (error: unknown) => {
				reject(error);
				// A failure nobody handles (by now: a body attaches handlers synchronously, or awaits) is
				// the spawning body's: it propagates up the call chain like an unhandled rejection.
				setImmediate(() => {
					if (result.handled || scope.dead) return;
					const failed = new ActorFailed(label, error);
					this.#note(`actor_failed:${address}`, { label, path: [...scope.path], message: failed.message });
					scope.fail(failed);
				});
			});
		});
		// Observed internally without marking it handled.
		Promise.prototype.then.call(result, undefined, () => {});
		return { address: { kind: "address", id: address }, result };
	}

	/** A call: checked, keyed, requested; its answer resolves `result`. */
	#start(scope: Scope, node: unknown, rawInput: unknown, options: { readonly turns?: number } | undefined): Running<unknown, unknown> {
		const seq = scope.seq++;
		const id = `${scope.prefix}${seq}`;
		let kind: Pending["kind"];
		let digest: string;
		let label: string;
		let schema: TSchema;
		let request: (input: Json) => Request;
		let extra: Partial<Pending> = {};
		let within = "";
		let one = false;
		if (isNode(node, "command")) {
			const d = commandDef(node as Command);
			[kind, digest, label, schema] = ["command", d.digest, d.label, d.input];
			request = (input) => ({ type: "command_call", name: d.label, input });
			extra = { command: d };
		} else if (isNode(node, "workflow")) {
			const d = workflowDef(node as Workflow);
			[kind, digest, label, schema] = ["workflow", d.digest, d.label, d.input];
			request = (input) => ({ type: "workflow_call", name: d.label, input });
			extra = { workflow: d };
		} else if (isNode(node, "tool")) {
			const d = toolDef(node as Tool);
			[kind, digest, label, schema] = ["tool", d.digest, d.label, Type.Unknown()];
			request = (input) => ({ type: "tool_call", name: d.label, input, replay_safe: this.#tools.replaySafe(d) });
			extra = { tool: d };
		} else if (isNode(node, "agent") || (node as { kind?: unknown })?.kind === "session") {
			const s: SessionData = isNode(node, "agent") ? (sessionValue(agentDef(node as Agent), null, []) as SessionData) : (node as SessionData);
			one = isNode(node, "agent");
			const d = isNode(node, "agent") ? agentDef(node as Agent) : sessionAgent(node as Session);
			if (!d) throw new Error("not a session value of this run: call ctx.session(agent) first");
			[kind, digest, label, schema] = ["agent", d.digest, d.label, d.input];
			within = s.id ?? (s.layers.length > 0 ? `new:${s.layers.join(",")}` : "");
			request = (input) => ({ type: "agent_call", name: d.label, input, session: s.id, from: s.id === null ? [...s.layers] : [] });
			extra = { agent: d, session: s, ...(options?.turns !== undefined ? { turns: options.turns } : {}) };
		} else throw new Error(`not a node: ${String(node)}`);
		const failNow = (message: string): Running<unknown, unknown> => {
			const r = Promise.reject(this.#nodeFailed(this.#ref("", label, scope.path, 0), { type: "body_error", message }));
			r.catch(() => {});
			return { address: { kind: "address", id: "" }, result: r };
		};
		// A body that has returned or failed (its leftover code, say after an actor failed it) makes no more calls.
		if (scope.dead) return failNow(`${label} was called after its body ended`);
		const json = toJson(rawInput);
		if (!json.ok) return failNow(`the input of ${label} is not JSON: ${json.error}`);
		const input = stripPaths(json.value);
		const errors = schemaErrors(schema, input);
		if (errors.length > 0) return failNow(`the input of ${label} does not match its schema: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
		// An address passed to an agent's Address(T) input: its recipient's schema must be T.
		if (kind === "agent") {
			for (const a of addressesIn(schema, input)) {
				const recipient = this.#schemas.get(a.id);
				if (recipient === undefined) return failNow(`${a.path}: ${a.id} has no mailbox in this run`);
				if (schemaDigest(recipient) !== schemaDigest(a.message)) return failNow(`${a.path}: the mailbox at ${a.id} takes another message schema than this input declares`);
			}
		}
		const occurrence = scope.occurrence(`${digest}\n${canonical(input)}`);
		const slot = slotText(digest, kind, input, scope.scope, within, occurrence);
		const address = kind === "agent" ? `agent:${slot}` : kind === "workflow" && extra.workflow?.mailbox ? `wf:${slot}` : "";
		if (kind === "agent" && extra.agent?.mailbox) this.#schemas.set(address, extra.agent.mailbox);
		if (kind === "workflow" && extra.workflow?.mailbox) this.#schemas.set(address, extra.workflow.mailbox);
		const result = new Promise<unknown>((resolve, reject) => {
			const call = (attempt: number) => this.#ref(slot, label, scope.path, attempt);
			this.#pending.set(id, {
				kind,
				label,
				path: scope.path,
				slot,
				input,
				scopeOf: scope,
				...extra,
				done: (value) => {
					if (kind !== "agent") return resolve(this.hostView(value));
					const v = value as { output: Json; session: string; layers: string[] };
					const next = sessionValue(extra.agent!, v.session, v.layers);
					this.#sessionIndex.set(v.session, next);
					resolve(one ? this.hostView(v.output) : [this.hostView(v.output), next]);
				},
				fail: (reason) => {
					if (reason.type === "agent_error" && reason.session !== null) {
						// The layers of a failure's session: noted, so a later process (a resume answering it from the journal) has them.
						const fact = `session_layers:${reason.session}`;
						const known = this.journal.core.facts()[fact];
						const layers = this.#failedLayers.get(id) ?? (Array.isArray(known) ? (known as string[]) : []);
						if (layers.length > 0 && !Array.isArray(known)) this.#note(fact, layers);
						this.#sessionIndex.set(reason.session, sessionValue(extra.agent!, reason.session, layers));
					}
					reject(this.#nodeFailed(call(this.journal.core.attemptCount(id)), reason));
				},
				refuse: (message) => reject(new Error(message)),
			});
			const go = () => this.step({ type: "requested", id, request: request(input), node: digest, scope: scope.scope, occurrence });
			// A tool's source is listed first, so the core knows whether it may be made again.
			if (extra.tool) this.#tools.prepare(extra.tool).then(go, go);
			else go();
		});
		result.catch(() => {});
		return { address: { kind: "address", id: address }, result };
	}

	/** The layers of the workspace after an agent call that failed (its session continues from them). */
	readonly #failedLayers = new Map<string, string[]>();

	// --- For agent runs ---------------------------------------------------------------------

	planFor(def: AgentDef): SandboxPlan {
		return this.plans.plan(def.workspace!.sandbox);
	}
}
