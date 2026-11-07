// A session drives one run until it needs attention: it holds the run's
// lock, refolds the log, runs the body in the sandbox, steps the core with
// every request and result, executes the core's effects and appends
// checkpointed events to the log. It ends when the run is finished or idle
// (nothing in flight: a node waits for an answer, the run is paused, the
// budget is spent, or the executor is unavailable). The next session
// resumes it.
//
// Resuming:
// 1. refold the log;
// 2. check the pin (`ResumableRun`; a refusal ends the session);
// 3. log the operational changes: executor, alias rebinds;
// 4. replay the body; the core answers completed requests from its journal
//    and reissues the ones that were in flight;
// 5. log budget raises, a retry of calls the executor could not serve,
//    answers and cancels.
//
// Interventions take capabilities (`OwnedRun`, `IdleNode`, `SteerableNode`,
// `LiveNode`), checked against the live core; the core checks them again
// when it applies the event.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { ArtifactRef, Json, Refusal } from "../sdk/index.ts";
import type { Declarations, Reply } from "../sdk/runtime.ts";
import { schemaErrors, toJson } from "../sdk/validate.ts";
import { ArtifactError, discardNode, type NodeDirs, nodeDirName, prepareNode, resolveDrafts, verifyRefs } from "./artifacts.ts";
import { bundleWorkflow } from "./bundle.ts";
import { HUMAN, IdleNode, LiveNode, must, OwnedRun, ResumableRun, SteerableNode } from "./capability.ts";
import { type BudgetKind, type CallAgentEffect, Core, type Effect, type Event, type Outcome, type Pin, SEMANTICS, type Snapshot, type Usage } from "./core.ts";
import type { Executor, NodeSession, NodeSpec, ScriptRunner, TranscriptEntry } from "./executor.ts";
import { EventLog } from "./log.ts";
import { type Profile, resolveModels } from "./models.ts";
import { type Mount, MountError, mountDigest, resolveMounts } from "./mounts.ts";
import { type LocalProfile, loadProfile } from "./profile.ts";
import { renderInput, windowCheck } from "./render.ts";
import { Sandbox } from "./sandbox.ts";
import { acquireLock, type InboxEntry, newMessageId, readInbox, readMeta, type RunPaths, runPaths, writeMeta } from "./store.ts";

export interface SessionOptions {
	/** The run directory. A directory without a log starts a new run. */
	readonly dir: string;
	/** Path to workflow.ts. Defaults to the one recorded for the run. */
	readonly workflow?: string;
	readonly executor: Executor;
	readonly scripts?: ScriptRunner;
	/** Recorded in the run's meta, so later sessions can recreate the executor. */
	readonly executorModule?: string | null;
	/** New runs only. */
	readonly input?: Json;
	/** Defaults to 0 for a new run and to the pinned seed on resume. */
	readonly seed?: number;
	/** Root for the pin's input files. Defaults to the recorded root, then the working directory. */
	readonly root?: string;
	/** New run: call-time alias remaps. Resume: rebinds, each logged as `alias_rebound`. */
	readonly models?: Readonly<Record<string, string>>;
	/** Call-time mount remaps (name -> dir). A changed mount digest is a pin mismatch on resume. */
	readonly mounts?: Readonly<Record<string, string>>;
	readonly profile?: Profile;
	/** The local profile (mounts, provider limits, slots). Defaults to the one on disk. */
	readonly local?: LocalProfile;
	/** Resume: raised limits, each logged as `budget_raised`. */
	readonly budget?: Readonly<Partial<Record<BudgetKind, number>>>;
	/** Who the session's own interventions (answers, cancel, unpause) come from. Default: the human. */
	readonly by?: string;
	/** Answers to idle nodes, sent once the body has replayed. */
	readonly sends?: readonly { readonly node: string; readonly text: string }[];
	readonly cancel?: boolean;
	/** Resume: lift a pause (`resume_requested`). */
	readonly unpause?: boolean;
	/** New runs: the owner, logged as `claimed` right after `started`. */
	readonly owner?: string;
	/** How often to read the inbox, in ms; `null` to not poll. */
	readonly inboxPollMs?: number | null;
	/** Lock owner; a parent that spawned this driver may have written it already. */
	readonly lockPid?: number;
}

export interface RunResult {
	readonly runId: string;
	readonly status: Snapshot["status"];
	readonly outcome: Outcome | null;
	/** JSON of the run (`Snapshot`); equal text means equal runs. */
	readonly snapshot: string;
	readonly run: Snapshot;
	readonly resumed: boolean;
}

/** The core refused the run as a whole (pin mismatch, path divergence, invalid declarations, unmet needs, unset mounts). */
export class RunRefused extends Error {
	override readonly name = "RunRefused";
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(`run refused: ${JSON.stringify(refusal)}`);
		this.refusal = refusal;
	}
}

const NO_USAGE: Usage = { usd: 0, tokens: 0, turns: 0 };

function digestFile(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

const refused = (refusal: Refusal) => new RunRefused(refusal);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function startSession(options: SessionOptions): Promise<Session> {
	const paths = runPaths(options.dir);
	const release = acquireLock(paths, options.lockPid);
	try {
		const meta = readMeta(paths);
		const workflow = options.workflow ?? meta?.workflow;
		if (!workflow) throw new Error(`run ${paths.id} has no workflow`);
		const root = options.root ?? meta?.root ?? process.cwd();
		if (!meta) {
			writeMeta(paths, {
				run_id: paths.id,
				workflow: resolve(workflow),
				root: resolve(root),
				executor: options.executorModule ?? null,
				created: new Date().toISOString(),
			});
		}
		const bundle = await bundleWorkflow(workflow);
		const session = new Session(paths, options, root, resolve(workflow), bundle.digest, release);
		await session.boot(bundle.code);
		return session;
	} catch (error) {
		release();
		throw error;
	}
}

/** One session; resolves when the run is finished or needs attention. */
export async function runWorkflow(options: SessionOptions): Promise<RunResult> {
	return (await startSession(options)).result;
}

export class Session {
	readonly paths: RunPaths;
	readonly result: Promise<RunResult>;
	readonly #options: SessionOptions;
	readonly #root: string;
	readonly #workflow: string;
	readonly #digest: string;
	readonly #release: () => void;
	readonly #log: EventLog;
	readonly #requests: Event[] = [];
	readonly #deliveries: [string, Reply][] = [];
	readonly #seen = new Set<string>();
	/** Answers to deliver once an interrupted turn has ended, with who sent them. */
	readonly #afterInterrupt = new Map<string, { text: string; by: string }>();
	/** Per node: the current executor turn. A result of an older turn (before a restart) is discarded. */
	readonly #generation = new Map<string, number>();
	#core = new Core();
	#sandbox: Sandbox | null = null;
	#decl!: Declarations;
	#local!: LocalProfile;
	#mounts: Record<string, Mount> = {};
	#resumed = false;
	#settled = false;
	#timer: ReturnType<typeof setInterval> | null = null;
	#done!: (result: RunResult) => void;
	#fail!: (error: unknown) => void;

	constructor(paths: RunPaths, options: SessionOptions, root: string, workflow: string, digest: string, release: () => void) {
		this.paths = paths;
		this.#options = options;
		this.#root = root;
		this.#workflow = workflow;
		this.#digest = digest;
		this.#release = release;
		this.#log = new EventLog(paths.log);
		this.result = new Promise<RunResult>((done, fail) => {
			this.#done = done;
			this.#fail = fail;
		});
		this.result.catch(() => {});
	}

	get settled(): boolean {
		return this.#settled;
	}

	snapshot(): Snapshot {
		return this.#core.snapshot();
	}

	/** The ownership check against the live run. */
	owned(by: string): OwnedRun | Refusal {
		return OwnedRun.check(this.#core.snapshot(), by);
	}

	/** Answers an idle node: its dialogue continues with the message. */
	answer(node: IdleNode, text: string, messageId = newMessageId()): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		this.#seen.add(messageId);
		const refusal = this.#feed({ type: "sent", node: node.node.id, text, message_id: messageId, by: node.owned.by })[0] ?? null;
		this.#settle();
		return refusal;
	}

	/** Steers a running node: the message reaches it at its next step boundary, with progress kept. */
	steer(node: SteerableNode, text: string, messageId = newMessageId()): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		this.#seen.add(messageId);
		const id = node.node.id;
		const refusal = this.#feed({ type: "steered", node: id, text, message_id: messageId, by: node.owned.by })[0] ?? null;
		if (refusal === null) {
			this.#transcriptLog(id)({ kind: "user", text: `[steer] ${text}` });
			this.#nodes.get(id)?.session.steer?.(text);
		}
		this.#settle();
		return refusal;
	}

	/** Aborts a running node's current step; `text`, if given, is delivered once it stops. Progress is kept. */
	interrupt(node: SteerableNode, text?: string): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const id = node.node.id;
		const refusal = this.#feed({ type: "interrupted", node: id, by: node.owned.by })[0];
		if (refusal) return refusal;
		if (text !== undefined) this.#afterInterrupt.set(id, { text, by: node.owned.by });
		this.#nodes.get(id)?.session.interrupt?.();
		return null;
	}

	/** Discards a node's progress and reissues its call with the original input and the note. Logged. */
	restart(node: LiveNode, note?: string): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const id = node.node.id;
		// The old session and dirs go first: the reissued call creates fresh ones.
		this.#nodes.get(id)?.session.interrupt?.();
		this.#closeNode(id);
		discardNode(this.paths.dir, id);
		this.#transcriptLog(id)({ kind: "note", text: `restarted${note === undefined ? "" : `: ${note}`}` });
		const refusal = this.#feed({ type: "restarted", node: id, note: note ?? null, by: node.owned.by })[0] ?? null;
		this.#pump();
		this.#settle();
		return refusal;
	}

	/** Fails one node as an agent failure; the body handles it. */
	cancelNode(node: LiveNode): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const id = node.node.id;
		const refusal = this.#feed({ type: "node_cancelled", node: id, by: node.owned.by })[0];
		if (refusal) return refusal;
		this.#nodes.get(id)?.session.interrupt?.();
		this.#closeNode(id);
		discardNode(this.paths.dir, id);
		this.#pump();
		this.#settle();
		return null;
	}

	/** Issues no new calls; in-flight ones finish. The run goes Idle(PausedByUser). */
	pause(owned: OwnedRun): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const refusal = this.#feed({ type: "pause_requested", by: owned.by })[0] ?? null;
		this.#settle();
		return refusal;
	}

	unpause(owned: OwnedRun): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const refusal = this.#feed({ type: "resume_requested", by: owned.by })[0] ?? null;
		this.#pump();
		this.#settle();
		return refusal;
	}

	cancel(owned: OwnedRun): Refusal | null {
		if (this.#settled) return null;
		const refusal = this.#feed({ type: "cancel_requested", by: owned.by })[0] ?? null;
		this.#settle();
		return refusal;
	}

	async boot(code: string): Promise<void> {
		try {
			await this.#boot(code);
		} catch (error) {
			this.#abort(error);
			throw error;
		}
	}


	async #boot(code: string): Promise<void> {
		const o = this.#options;
		const by = o.by ?? HUMAN;
		const prior = this.#log.read();
		this.#resumed = prior.length > 0;
		this.#sandbox = await Sandbox.create(code, {
			send: (json) => this.#requests.push(JSON.parse(json) as Event),
			done: (json) => this.#requests.push({ type: "body_finished", output: JSON.parse(json) as Json }),
			fail: (json) => this.#requests.push({ type: "body_failed", reason: JSON.parse(json) }),
		});
		const decl = this.#sandbox.declare();
		this.#decl = decl;
		this.#local = o.local ?? loadProfile(this.#root);
		try {
			this.#mounts = resolveMounts(decl.core.name, dirname(this.#workflow), decl.mounts, { root: this.#root, callTime: o.mounts, profile: this.#local.mounts });
		} catch (error) {
			if (error instanceof MountError) throw new RunRefused(error.refusal);
			throw error;
		}
		const inputs: Record<string, string> = Object.fromEntries(decl.pin.files.map((f) => [f, digestFile(resolve(this.#root, f))]));
		// Mounts are read in place, never copied: their content digest is pinned.
		for (const [name, mount] of Object.entries(this.#mounts)) inputs[`mount.${name}`] = mountDigest(mount.dir);

		let input: Json;
		let seed: number;
		if (prior.length === 0) {
			this.#preflight();
			seed = o.seed ?? 0;
			const pin: Pin = {
				workflow_digest: this.#digest,
				models: resolveModels(decl.core.name, decl.models, { callTime: o.models, profile: o.profile ?? this.#local.models }),
				seed,
				inputs,
				semantics: SEMANTICS,
			};
			input = o.input ?? null;
			this.#refuseOn(this.#feed({ type: "started", workflow: decl.core as unknown as Json, pin, input }));
			this.#feed({ type: "executor_changed", name: o.executor.id });
			if (o.owner) this.#feed({ type: "claimed", owner: o.owner });
		} else {
			const first = prior[0]!;
			if (first.type !== "started") throw new Error(`log ${this.paths.log} does not begin with a started event`);
			this.#core = Core.refold(prior);
			for (const e of prior) if (e.type === "sent" || e.type === "steered") this.#seen.add(e.message_id);
			seed = o.seed ?? first.pin.seed;
			input = first.input;
			must(ResumableRun.check(this.#core, { workflow_digest: this.#digest, models: first.pin.models, seed, inputs, semantics: SEMANTICS }), refused);
			if (this.#core.snapshot().status.type === "finished") return this.#complete();
			const snap = this.#core.snapshot();
			if (snap.executor !== o.executor.id) this.#feed({ type: "executor_changed", name: o.executor.id });
			for (const [alias, to] of Object.entries(o.models ?? {})) {
				const from = snap.models[alias];
				if (from === undefined) this.#refuseOn([{ type: "unknown_alias", alias }]);
				else if (from !== to) this.#refuseOn(this.#feed({ type: "alias_rebound", alias, from, to }));
			}
		}
		if (existsSync(this.#doneInbox())) for (const id of readFileSync(this.#doneInbox(), "utf8").split("\n")) if (id) this.#seen.add(id);

		if (o.cancel) this.#refuseOn([this.cancel(must(this.owned(by), refused))].filter((r) => r !== null));
		if (this.#settled) return;

		this.#sandbox.start(input, seed);
		this.#pump();
		for (const [kind, limit] of Object.entries(o.budget ?? {})) {
			this.#feed({ type: "budget_raised", kind: kind as BudgetKind, limit: limit! });
		}
		this.#feed({ type: "retry_unavailable" });
		if (o.unpause && !this.#settled) this.#refuseOn([this.unpause(must(this.owned(by), refused))].filter((r) => r !== null));
		for (const s of o.sends ?? []) {
			const owned = must(this.owned(by), refused);
			const refusal = this.answer(must(IdleNode.check(owned, s.node), refused), s.text);
			if (refusal) throw new RunRefused(refusal);
		}
		this.#drainInbox();
		this.#pump();
		this.#settle();
		const poll = o.inboxPollMs === undefined ? 100 : o.inboxPollMs;
		if (!this.#settled && poll !== null) {
			this.#timer = setInterval(() => this.#later(() => this.#drainInbox()), poll);
		}
	}

	#mountDirs(names: readonly string[]): Record<string, string> {
		return Object.fromEntries(names.map((n) => [n, this.#mounts[n]!.dir]));
	}

	#mcpFor(declaration: Declarations["agents"][string]): Json | null {
		const servers = (this.#decl.mcp as { mcpServers?: Record<string, Json> } | null)?.mcpServers;
		if (!servers) return null;
		return Object.fromEntries(Object.keys(declaration.mcp).filter((s) => s in servers).map((s) => [s, servers[s]!]));
	}

	#preflight(): void {
		const caps = this.#options.executor.capabilities;
		if (!caps) return;
		for (const [agent, d] of Object.entries(this.#decl.agents)) {
			const needs = d.needs as { structuredOutput?: boolean; toolCalls?: boolean; contextTokens?: number };
			if (needs.structuredOutput && caps.structuredOutput === false) throw new RunRefused({ type: "needs_unmet", agent, need: "structuredOutput" });
			if (needs.toolCalls && caps.toolCalls === false) throw new RunRefused({ type: "needs_unmet", agent, need: "toolCalls" });
			if (needs.contextTokens && caps.contextTokens !== undefined && caps.contextTokens < needs.contextTokens) {
				throw new RunRefused({ type: "needs_unmet", agent, need: `contextTokens >= ${needs.contextTokens}` });
			}
		}
	}

	#refuseOn(refusals: Refusal[]): void {
		if (refusals.length > 0) throw new RunRefused(refusals[0]!);
	}

	#doneInbox(): string {
		return `${this.paths.inbox}.done`;
	}

	/** Applies one inbox entry from another process, checking its capabilities against the live run. */
	#applyEntry(entry: InboxEntry): Refusal | null {
		if (entry.type === "claim") {
			this.#feed({ type: "claimed", owner: entry.owner });
			return null;
		}
		const owned = this.owned(entry.by);
		if (!(owned instanceof OwnedRun)) return owned;
		switch (entry.type) {
			case "cancel":
				return this.cancel(owned);
			case "pause":
				return this.pause(owned);
			case "resume":
				return this.unpause(owned);
			case "answer": {
				const node = IdleNode.check(owned, entry.node);
				return node instanceof IdleNode ? this.answer(node, entry.text, entry.id) : node;
			}
			case "steer":
			case "interrupt": {
				const node = SteerableNode.check(owned, entry.node);
				if (!(node instanceof SteerableNode)) return node;
				return entry.type === "steer" ? this.steer(node, entry.text, entry.id) : this.interrupt(node, entry.text);
			}
			case "restart":
			case "cancel_node": {
				const node = LiveNode.check(owned, entry.node);
				if (!(node instanceof LiveNode)) return node;
				return entry.type === "restart" ? this.restart(node, entry.note) : this.cancelNode(node);
			}
		}
	}

	#drainInbox(): void {
		for (const entry of readInbox(this.paths)) {
			if (this.#settled || this.#seen.has(entry.id)) continue;
			this.#seen.add(entry.id);
			const refusal = this.#applyEntry(entry);
			appendFileSync(this.#doneInbox(), `${entry.id}\n`);
			if (refusal) {
				appendFileSync(`${this.paths.inbox}.refused`, `${JSON.stringify({ id: entry.id, refusal })}\n`);
				process.stderr.write(`wallis: inbox entry ${entry.id} (${entry.type}) refused: ${JSON.stringify(refusal)}\n`);
			}
		}
	}

	/** Steps one event; returns the refusals of the event itself. */
	#feed(event: Event): Refusal[] {
		const refusals: Refusal[] = [];
		for (const effect of this.#core.step(event)) {
			if (effect.type === "refuse" && effect.id === null) refusals.push(effect.refusal);
			else this.#handle(effect, event);
		}
		return refusals;
	}

	#pump(): void {
		while (!this.#settled && (this.#deliveries.length > 0 || this.#requests.length > 0)) {
			const delivery = this.#deliveries.shift();
			if (delivery) {
				this.#sandbox!.deliver(delivery[0], delivery[1] as unknown as Json);
				continue;
			}
			const event = this.#requests.shift()!;
			if (event.type === "requested") {
				const invalid = this.#invalidRequest(event.request);
				if (invalid) {
					// Rejected at the boundary: the body gets a typed error and nothing is logged.
					this.#deliveries.push([event.id, invalid]);
					continue;
				}
			}
			const refusals = this.#feed(event);
			// A request the core refuses as an event is a path divergence: the body took another path.
			if (refusals.length > 0) throw new RunRefused(refusals[0]!);
		}
	}

	#invalidRequest(request: Json): Reply | null {
		const r = request as { type: string; agent?: string; input?: Json; script?: string; args?: Json };
		const fail = (subject: string, errors: string[]): Reply | null => (errors.length > 0 ? { type: "schema", subject, errors } : null);
		switch (r.type) {
			case "call": {
				const agent = this.#decl.agents[r.agent!];
				return agent ? fail(`input of agent ${r.agent}`, schemaErrors(agent.input, r.input)) : null;
			}
			case "script": {
				const script = this.#decl.scripts[r.script!];
				return script ? fail(`args of script ${r.script}`, schemaErrors(script.input, r.args)) : null;
			}
			default:
				return null;
		}
	}

	/** Runs an async completion: feed, pump, maybe settle. */
	#later(step: () => void): void {
		if (this.#settled) return;
		try {
			step();
			this.#pump();
			this.#settle();
		} catch (error) {
			this.#abort(error);
		}
	}

	#handle(effect: Effect, event: Event): void {
		switch (effect.type) {
			case "checkpoint":
				this.#log.append(event);
				return;
			case "call_agent":
				this.#callAgent(effect);
				return;
			case "run_script":
				this.#runScript(effect);
				return;
			case "deliver":
				this.#deliveries.push([effect.id, { type: "deliver", value: effect.value }]);
				return;
			case "fail":
				this.#deliveries.push([effect.id, { type: "fail", reason: effect.reason }]);
				return;
			case "refuse":
				this.#deliveries.push([effect.id!, { type: "refuse", refusal: effect.refusal }]);
				return;
			case "finish":
				this.#complete();
				return;
		}
	}

	/**
	 * A producer's output, parsed: JSON, drafts stored as artifacts, every ref
	 * verified against the store, then the schema. Errors are a string.
	 */
	#parseOutput(output: unknown, schema: unknown, scratch: string | null): { ok: true; value: Json } | { ok: false; error: string } {
		const json = toJson(output);
		if (!json.ok) return { ok: false, error: `output is not JSON: ${json.errors.join("; ")}` };
		let value: Json;
		try {
			value = resolveDrafts(json.value, this.paths.dir, scratch);
			verifyRefs(value, this.paths.dir);
		} catch (error) {
			if (error instanceof ArtifactError) return { ok: false, error: error.message };
			throw error;
		}
		const errors = schemaErrors(schema, value);
		return errors.length > 0 ? { ok: false, error: `output does not match its schema: ${errors.join("; ")}` } : { ok: true, value };
	}

	/** The node's open executor session, kept while the node is idle. */
	readonly #nodes = new Map<string, { session: NodeSession; model: string }>();

	#transcriptLog(id: string): (entry: TranscriptEntry) => void {
		const file = join(this.paths.dir, "nodes", `${nodeDirName(id)}.jsonl`);
		return (entry) => {
			mkdirSync(join(this.paths.dir, "nodes"), { recursive: true });
			appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
		};
	}

	#closeNode(id: string): void {
		const open = this.#nodes.get(id);
		this.#nodes.delete(id);
		if (open) void Promise.resolve(open.session.close()).catch(() => {});
	}

	#callAgent(effect: CallAgentEffect): void {
		const id = effect.id;
		const declaration = this.#decl.agents[effect.agent]!;
		const generation = (this.#generation.get(id) ?? 0) + 1;
		this.#generation.set(id, generation);
		const current = () => this.#generation.get(id) === generation;
		const log = this.#transcriptLog(id);
		const base = { id, model: effect.model };
		const failed = (error: string) =>
			queueMicrotask(() => this.#later(() => this.#feed({ type: "agent_failed", ...base, failure: { type: "gave_up", error }, usage: NO_USAGE })));

		let workspace: NodeDirs;
		try {
			workspace = prepareNode(this.paths.dir, id, declaration.sandbox, effect.input, this.#mountDirs(declaration.mounts));
		} catch (error) {
			if (!(error instanceof ArtifactError)) throw error;
			return failed(error.message);
		}
		const rendered = renderInput(declaration.input, effect.input);
		const contextTokens = this.#options.executor.contextWindow?.(effect.model);
		if (effect.transcript.length === 0) {
			// The window check, before the first request of the call.
			const over = windowCheck(declaration.prompt.length + (effect.note?.length ?? 0), rendered, contextTokens);
			if (over) {
				log({ kind: "note", text: `input refused: ${over.chars} chars over the window's ${over.limit}` });
				queueMicrotask(() => this.#later(() => this.#feed({ type: "input_rejected", id, ...over })));
				return;
			}
		}
		const last = effect.transcript.at(-1);
		const message = last?.role === "user" ? last.text : undefined;
		const spec: NodeSpec = {
			id,
			agent: effect.agent,
			declaration,
			model: effect.model,
			prompt: rendered.text,
			input: effect.input,
			note: effect.note,
			contextTokens,
			maxTurns: effect.max_turns,
			digest: effect.digest,
			transcript: message === undefined ? effect.transcript : effect.transcript.slice(0, -1),
			outputSchema: declaration.output as unknown as Json,
			workspace,
			exportArtifact: (path, media, name) =>
				resolveDrafts(name === undefined ? { artifact: path, media } : { artifact: path, media, name }, this.paths.dir, workspace.scratch) as unknown as ArtifactRef,
			mcp: this.#mcpFor(declaration),
			log,
		};
		const done = () => {
			this.#closeNode(id);
			discardNode(this.paths.dir, id);
		};
		const session = async (): Promise<NodeSession> => {
			const open = this.#nodes.get(id);
			// A continued node keeps its session; a new model is a rebind, or a restart.
			if (open && message !== undefined) {
				if (open.model === effect.model) return open.session;
				if (open.session.rebind) {
					open.session.rebind(effect.model);
					open.model = effect.model;
					log({ kind: "note", text: `rebound to ${effect.model}` });
					return open.session;
				}
			}
			this.#closeNode(id);
			const started = await this.#options.executor.start(spec);
			this.#nodes.set(id, { session: started, model: effect.model });
			return started;
		};
		if (message !== undefined) log({ kind: "user", text: message });
		session()
			.then((s) => s.turn(message))
			.then(
				(turn) =>
					this.#later(() => {
						if (!current()) {
							log({ kind: "note", text: `discarded the ${turn.type} turn of a call that was restarted or cancelled` });
							return;
						}
						if (turn.type === "executor_error") {
							this.#closeNode(id);
							log({ kind: "turn", result: `executor_error: ${turn.error}` });
							this.#feed({ type: "executor_failed", id, error: turn.error });
							return;
						}
						const usage = turn.usage ?? NO_USAGE;
						log({ kind: "turn", result: turn.type, usage });
						if (turn.type === "ended") {
							this.#feed({ type: "agent_idle", ...base, message: turn.message, usage });
							const parked = this.#afterInterrupt.get(id);
							if (parked !== undefined) {
								this.#afterInterrupt.delete(id);
								const owned = this.owned(parked.by);
								const node = owned instanceof OwnedRun ? IdleNode.check(owned, id) : owned;
								const refusal = node instanceof IdleNode ? this.answer(node, parked.text) : node;
								if (refusal) log({ kind: "note", text: `the message after the interrupt was refused: ${JSON.stringify(refusal)}` });
							}
							return;
						}
						if (turn.type === "agent_error") {
							this.#feed({ type: "agent_failed", ...base, failure: turn.failure, usage });
							done();
							return;
						}
						const parsed = this.#parseOutput(turn.output, declaration.output, workspace.scratch);
						if (parsed.ok) this.#feed({ type: "agent_returned", ...base, output: parsed.value, usage });
						else this.#feed({ type: "agent_failed", ...base, failure: { type: "gave_up", error: parsed.error }, usage });
						done();
					}),
				(error: unknown) =>
					this.#later(() => {
						if (!current()) return;
						this.#closeNode(id);
						this.#feed({ type: "executor_failed", id, error: errorText(error) });
					}),
			);
	}

	#runScript(effect: Extract<Effect, { type: "run_script" }>): void {
		const runner = this.#options.scripts;
		const id = effect.id;
		const failed = (error: string) => queueMicrotask(() => this.#later(() => this.#feed({ type: "script_failed", id, error, minutes: 0 })));
		if (!runner) return failed("no script runner");
		const declaration = this.#decl.scripts[effect.script];
		let workspace: NodeDirs;
		try {
			workspace = prepareNode(this.paths.dir, id, declaration?.sandbox ?? "workspace", effect.args, this.#mountDirs(declaration?.mounts ?? []));
		} catch (error) {
			return failed(errorText(error));
		}
		const done = () => discardNode(this.paths.dir, id);
		runner
			.run({
				id,
				script: effect.script,
				args: effect.args,
				computeMinutes: effect.compute_minutes,
				digest: effect.digest,
				outputSchema: (declaration?.output ?? {}) as Json,
				workspace,
				resources: declaration?.resources ?? {},
			})
			.then(
				(result) =>
					this.#later(() => {
						const parsed = this.#parseOutput(result.output, declaration?.output ?? {}, workspace.scratch);
						if (parsed.ok) this.#feed({ type: "script_returned", id, output: parsed.value, minutes: result.minutes });
						else this.#feed({ type: "script_failed", id, error: parsed.error, minutes: result.minutes });
						done();
					}),
				(error: unknown) =>
					this.#later(() => {
						this.#feed({ type: "script_failed", id, error: errorText(error), minutes: 0 });
						done();
					}),
			);
	}

	/** Ends the session once nothing is queued and the run no longer runs. */
	#settle(): void {
		if (this.#settled || this.#requests.length > 0 || this.#deliveries.length > 0) return;
		const status = this.#core.snapshot().status;
		if (status.type === "running") return;
		if (status.type === "idle") {
			// A message may have arrived since the last poll.
			this.#drainInbox();
			if (this.#settled) return;
			this.#pump();
			if (this.#core.snapshot().status.type === "running") return;
		}
		this.#complete();
	}

	#complete(): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#cleanup();
		const run = this.#core.snapshot();
		this.#done({
			runId: this.paths.id,
			status: run.status,
			outcome: run.status.type === "finished" ? run.status.outcome : null,
			snapshot: this.#core.snapshotText(),
			run,
			resumed: this.#resumed,
		});
	}

	#abort(error: unknown): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#cleanup();
		this.#fail(error);
	}

	#cleanup(): void {
		if (this.#timer) clearInterval(this.#timer);
		for (const id of [...this.#nodes.keys()]) this.#closeNode(id);
		this.#sandbox?.dispose();
		this.#sandbox = null;
		this.#release();
	}
}
