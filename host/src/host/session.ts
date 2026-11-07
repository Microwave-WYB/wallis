// A session drives one run until it needs attention: it holds the run's
// lock, refolds the log, runs the body in the sandbox, steps the core with
// every request and result, executes the core's effects and appends
// checkpointed events to the log. It ends when the run is finished or idle
// (nothing in flight: a node waits for a message, the budget is spent, or
// the executor is unavailable). The next session resumes it.
//
// Resuming:
// 1. refold the log;
// 2. check the pin (`resumed`; a refusal ends the session);
// 3. log the operational changes: executor, alias rebinds;
// 4. replay the body; the core answers completed requests from its journal
//    and reissues the ones that were in flight;
// 5. log budget raises, a retry of calls the executor could not serve,
//    sends and cancels.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { ArtifactRef, Json, Refusal } from "../sdk/index.ts";
import type { Declarations, Reply } from "../sdk/runtime.ts";
import { schemaErrors } from "../sdk/validate.ts";
import { ArtifactError, discardNode, manifestDigest, type NodeDirs, nodeDirName, prepareNode, resolveDrafts } from "./artifacts.ts";
import { bundleWorkflow } from "./bundle.ts";
import { Core, type BudgetKind, type Effect, type Event, type Outcome, type Pin, SEMANTICS, type Snapshot, type Usage } from "./core.ts";
import type { Executor, NodeSession, NodeSpec, ScriptRunner, TranscriptEntry } from "./executor.ts";
import { EventLog } from "./log.ts";
import { type Profile, resolveModels } from "./models.ts";
import { type LocalProfile, loadProfile } from "./profile.ts";
import { Sandbox } from "./sandbox.ts";
import { acquireLock, newMessageId, readInbox, readMeta, type RunPaths, runPaths, writeMeta } from "./store.ts";

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
	readonly profile?: Profile;
	/** The local profile (data dirs, provider limits, slots). Defaults to the one on disk. */
	readonly local?: LocalProfile;
	/** Resume: raised limits, each logged as `budget_raised`. */
	readonly budget?: Readonly<Partial<Record<BudgetKind, number>>>;
	/** Messages to idle nodes, sent once the body has replayed. */
	readonly sends?: readonly { readonly node: string; readonly text: string }[];
	readonly cancel?: boolean;
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

/** The core refused the run as a whole (pin mismatch, path divergence, invalid declarations, unmet needs). */
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

function getPath(value: Json, path: string): Json | undefined {
	let v: Json | undefined = value;
	for (const key of path.split(".")) {
		if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
		v = v[key];
	}
	return v;
}

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
		const session = new Session(paths, options, root, bundle.digest, release);
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
	readonly #digest: string;
	readonly #release: () => void;
	readonly #log: EventLog;
	readonly #requests: Event[] = [];
	readonly #deliveries: [string, Reply][] = [];
	readonly #seen = new Set<string>();
	#core = new Core();
	#sandbox: Sandbox | null = null;
	#decl!: Declarations;
	#local!: LocalProfile;
	#resumed = false;
	#settled = false;
	#timer: ReturnType<typeof setInterval> | null = null;
	#done!: (result: RunResult) => void;
	#fail!: (error: unknown) => void;

	constructor(paths: RunPaths, options: SessionOptions, root: string, digest: string, release: () => void) {
		this.paths = paths;
		this.#options = options;
		this.#root = root;
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

	/** Sends a message to an idle node. Returns the refusal if the core refused it. */
	send(node: string, text: string, messageId = newMessageId()): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		this.#seen.add(messageId);
		const refusals = this.#feed({ type: "sent", node, text, message_id: messageId });
		this.#settle();
		return refusals[0] ?? null;
	}

	cancel(): void {
		if (this.#settled) return;
		this.#feed({ type: "cancel_requested" });
		this.#settle();
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
		const inputs: Record<string, string> = Object.fromEntries(decl.pin.files.map((f) => [f, digestFile(resolve(this.#root, f))]));
		// Datasets are mounted, not copied: their manifest digest is pinned.
		for (const name of this.#dataNames()) inputs[`data.${name}`] = manifestDigest(this.#dataPath(name));

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
			for (const e of prior) if (e.type === "sent") this.#seen.add(e.message_id);
			seed = o.seed ?? first.pin.seed;
			input = first.input;
			const pin: Pin = { workflow_digest: this.#digest, models: first.pin.models, seed, inputs, semantics: SEMANTICS };
			this.#refuseOn(this.#feed({ type: "resumed", pin }));
			if (this.#settled) return;
			const snap = this.#core.snapshot();
			if (snap.executor !== o.executor.id) this.#feed({ type: "executor_changed", name: o.executor.id });
			for (const [alias, to] of Object.entries(o.models ?? {})) {
				const from = snap.models[alias];
				if (from === undefined) this.#refuseOn([{ type: "unknown_alias", alias }]);
				else if (from !== to) this.#refuseOn(this.#feed({ type: "alias_rebound", alias, from, to }));
			}
		}
		if (existsSync(this.#doneInbox())) for (const id of readFileSync(this.#doneInbox(), "utf8").split("\n")) if (id) this.#seen.add(id);

		if (o.cancel) this.cancel();
		if (this.#settled) return;

		this.#sandbox.start(input, seed);
		this.#pump();
		for (const [kind, limit] of Object.entries(o.budget ?? {})) {
			this.#feed({ type: "budget_raised", kind: kind as BudgetKind, limit: limit! });
		}
		this.#feed({ type: "retry_unavailable" });
		for (const s of o.sends ?? []) {
			const refusal = this.send(s.node, s.text);
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

	#dataNames(): string[] {
		const names = [...Object.values(this.#decl.agents).flatMap((a) => a.data), ...Object.values(this.#decl.scripts).flatMap((s) => s.data)];
		return [...new Set(names)].sort();
	}

	#dataPath(name: string): string {
		const path = this.#local.data?.[name];
		if (!path) throw new Error(`data dir ${name} is not in the local profile (data.${name} in .wallis/profile.json)`);
		return resolve(this.#root, path);
	}

	#dirs(id: string, level: NodeDirs["level"], input: Json, data: readonly string[]): NodeDirs {
		return prepareNode(this.paths.dir, id, level, input, Object.fromEntries(data.map((n) => [n, this.#dataPath(n)])));
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

	#drainInbox(): void {
		for (const entry of readInbox(this.paths)) {
			if (this.#settled || this.#seen.has(entry.id)) continue;
			this.#seen.add(entry.id);
			appendFileSync(this.#doneInbox(), `${entry.id}\n`);
			if (entry.type === "cancel") this.cancel();
			else if (entry.type === "claim") this.#feed({ type: "claimed", owner: entry.owner });
			else {
				const refusal = this.send(entry.node, entry.text, entry.id);
				if (refusal) process.stderr.write(`wallis: message ${entry.id} to ${entry.node} refused: ${JSON.stringify(refusal)}\n`);
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
		const r = request as { type: string; agent?: string; input?: Json; script?: string; args?: Json; writes?: { field: string; value: Json }[] };
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
			case "commit":
				for (const w of r.writes ?? []) {
					const schema = this.#decl.fields[w.field];
					const reply = schema ? fail(`write to state field ${w.field}`, schemaErrors(schema, w.value)) : null;
					if (reply) return reply;
				}
				return null;
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
				this.#finish();
				return;
		}
	}

	/** The output, emits and mapped writes, checked against their schemas before anything is logged. */
	#resultErrors(effect: Extract<Effect, { type: "call_agent" }>, output: Json, emits: readonly { field: string; value: Json }[]): string | null {
		const declaration = this.#decl.agents[effect.agent]!;
		const errors = schemaErrors(declaration.output, output);
		if (errors.length > 0) return `output does not match its schema: ${errors.join("; ")}`;
		for (const e of emits) {
			const schema = this.#decl.fields[e.field];
			const bad = schema ? schemaErrors(schema, e.value) : [];
			if (bad.length > 0) return `emit to state field ${e.field} does not match its schema: ${bad.join("; ")}`;
		}
		for (const [field, source] of Object.entries(declaration.writes)) {
			if (typeof source !== "string") continue;
			const value = getPath(output, source);
			const schema = this.#decl.fields[field];
			if (value === undefined || value === null || !schema) continue;
			const bad = schemaErrors(schema, value);
			if (bad.length > 0) return `write to state field ${field} does not match its schema: ${bad.join("; ")}`;
		}
		return null;
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

	/** Steers a running node: the message reaches it at its next step boundary. */
	steerNode(id: string, text: string): boolean {
		const open = this.#nodes.get(id);
		if (!open?.session.steer) return false;
		open.session.steer(text);
		return true;
	}

	/** Aborts a running node's current generation or tool. */
	interruptNode(id: string): boolean {
		const open = this.#nodes.get(id);
		if (!open?.session.interrupt) return false;
		open.session.interrupt();
		return true;
	}

	#callAgent(effect: Extract<Effect, { type: "call_agent" }>): void {
		const declaration = this.#decl.agents[effect.agent]!;
		const workspace = this.#dirs(effect.id, declaration.sandbox, effect.input, declaration.data);
		const last = effect.transcript.at(-1);
		const message = last?.role === "user" ? last.text : undefined;
		const log = this.#transcriptLog(effect.id);
		const spec: NodeSpec = {
			id: effect.id,
			agent: effect.agent,
			declaration,
			model: effect.model,
			view: effect.view,
			omitted: effect.omitted,
			input: effect.input,
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
		const base = { id: effect.id, model: effect.model };
		const done = () => {
			this.#closeNode(effect.id);
			discardNode(this.paths.dir, effect.id);
		};
		const session = async (): Promise<NodeSession> => {
			const open = this.#nodes.get(effect.id);
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
			this.#closeNode(effect.id);
			const started = await this.#options.executor.start(spec);
			this.#nodes.set(effect.id, { session: started, model: effect.model });
			return started;
		};
		if (message !== undefined) log({ kind: "user", text: message });
		session()
			.then((s) => s.turn(message))
			.then(
				(turn) =>
					this.#later(() => {
						if (turn.type === "executor_error") {
							this.#closeNode(effect.id);
							log({ kind: "turn", result: `executor_error: ${turn.error}` });
							this.#feed({ type: "executor_failed", id: effect.id, error: turn.error });
							return;
						}
						const usage = turn.usage ?? NO_USAGE;
						log({ kind: "turn", result: turn.type, usage });
						if (turn.type === "ended") {
							this.#feed({ type: "agent_idle", ...base, message: turn.message, usage });
							return;
						}
						if (turn.type === "agent_error") {
							this.#feed({ type: "agent_failed", ...base, error: turn.error, usage });
							done();
							return;
						}
						let output: Json;
						let emits: { field: string; value: Json }[];
						try {
							output = resolveDrafts(turn.output, this.paths.dir, workspace.scratch);
							emits = (turn.emits ?? []).map((e) => ({ field: e.field, value: resolveDrafts(e.value, this.paths.dir, workspace.scratch) }));
						} catch (error) {
							if (!(error instanceof ArtifactError)) throw error;
							this.#feed({ type: "agent_failed", ...base, error: error.message, usage });
							done();
							return;
						}
						const invalid = this.#resultErrors(effect, output, emits);
						if (invalid) this.#feed({ type: "agent_failed", ...base, error: invalid, usage });
						else this.#feed({ type: "agent_returned", ...base, output, emits, usage });
						done();
					}),
				(error: unknown) =>
					this.#later(() => {
						this.#closeNode(effect.id);
						this.#feed({ type: "executor_failed", id: effect.id, error: errorText(error) });
					}),
			);
	}

	#runScript(effect: Extract<Effect, { type: "run_script" }>): void {
		const runner = this.#options.scripts;
		const id = effect.id;
		if (!runner) {
			queueMicrotask(() => this.#later(() => this.#feed({ type: "script_failed", id, error: "no script runner", minutes: 0 })));
			return;
		}
		const declaration = this.#decl.scripts[effect.script];
		let workspace: NodeDirs;
		try {
			workspace = this.#dirs(id, declaration?.sandbox ?? "workspace", effect.args, declaration?.data ?? []);
		} catch (error) {
			queueMicrotask(() => this.#later(() => this.#feed({ type: "script_failed", id, error: errorText(error), minutes: 0 })));
			return;
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
						let output: Json;
						try {
							output = resolveDrafts(result.output, this.paths.dir, workspace.scratch);
						} catch (error) {
							if (!(error instanceof ArtifactError)) throw error;
							this.#feed({ type: "script_failed", id, error: error.message, minutes: result.minutes });
							done();
							return;
						}
						const errors = declaration ? schemaErrors(declaration.output, output) : [];
						if (errors.length > 0) {
							this.#feed({ type: "script_failed", id, error: `output does not match its schema: ${errors.join("; ")}`, minutes: result.minutes });
						} else {
							this.#feed({ type: "script_returned", id, output, minutes: result.minutes });
						}
						done();
					}),
				(error: unknown) =>
					this.#later(() => {
						this.#feed({ type: "script_failed", id, error: errorText(error), minutes: 0 });
						done();
					}),
			);
	}

	#finish(): void {
		this.#complete();
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
