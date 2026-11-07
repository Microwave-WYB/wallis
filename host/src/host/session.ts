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

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Json, Refusal } from "../sdk/index.ts";
import type { Declarations, Reply } from "../sdk/runtime.ts";
import { schemaErrors } from "../sdk/validate.ts";
import { bundleWorkflow } from "./bundle.ts";
import { Core, type BudgetKind, type Effect, type Event, type Outcome, type Pin, SEMANTICS, type Snapshot, type Usage } from "./core.ts";
import { type AgentCall, AgentFailure, type Executor, type ScriptRunner } from "./executor.ts";
import { EventLog } from "./log.ts";
import { type Profile, resolveModels } from "./models.ts";
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
	/** Resume: raised limits, each logged as `budget_raised`. */
	readonly budget?: Readonly<Partial<Record<BudgetKind, number>>>;
	/** Messages to idle nodes, sent once the body has replayed. */
	readonly sends?: readonly { readonly node: string; readonly text: string }[];
	readonly cancel?: boolean;
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
		const inputs = Object.fromEntries(decl.pin.files.map((f) => [f, digestFile(resolve(this.#root, f))]));

		let input: Json;
		let seed: number;
		if (prior.length === 0) {
			this.#preflight();
			seed = o.seed ?? 0;
			const pin: Pin = {
				workflow_digest: this.#digest,
				models: resolveModels(decl.core.name, decl.models, { callTime: o.models, profile: o.profile }),
				seed,
				inputs,
				semantics: SEMANTICS,
			};
			input = o.input ?? null;
			this.#refuseOn(this.#feed({ type: "started", workflow: decl.core as unknown as Json, pin, input }));
			if (o.executor.name) this.#feed({ type: "executor_changed", name: o.executor.name });
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
			if (o.executor.name && snap.executor !== o.executor.name) this.#feed({ type: "executor_changed", name: o.executor.name });
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
		const merge = effect.id.indexOf("/merge/");
		if (merge >= 0) {
			const field = effect.id.slice(merge + "/merge/".length);
			const schema = this.#decl.fields[field];
			const items = getPath(output, "items");
			const bad = schema && items !== undefined ? schemaErrors(schema, items) : [];
			if (bad.length > 0) return `merged items do not match state field ${field}: ${bad.join("; ")}`;
		}
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

	#callAgent(effect: Extract<Effect, { type: "call_agent" }>): void {
		const declaration = this.#decl.agents[effect.agent]!;
		const call: AgentCall = {
			id: effect.id,
			agent: effect.agent,
			declaration,
			model: effect.model,
			view: effect.view,
			omitted: effect.omitted,
			input: effect.input,
			maxTurns: effect.max_turns,
			digest: effect.digest,
			transcript: effect.transcript,
			outputSchema: declaration.output as unknown as Json,
		};
		const base = { id: effect.id, model: effect.model };
		this.#options.executor.call(call).then(
			(turn) =>
				this.#later(() => {
					const usage = turn.usage ?? NO_USAGE;
					if (turn.type === "idle") {
						this.#feed({ type: "agent_idle", ...base, message: turn.message, usage });
						return;
					}
					const emits = [...(turn.emits ?? [])];
					const invalid = this.#resultErrors(effect, turn.output, emits);
					if (invalid) this.#feed({ type: "agent_failed", ...base, error: invalid, usage });
					else this.#feed({ type: "agent_returned", ...base, output: turn.output, emits, usage });
				}),
			(error: unknown) =>
				this.#later(() => {
					if (error instanceof AgentFailure) this.#feed({ type: "agent_failed", ...base, error: error.message, usage: error.usage ?? NO_USAGE });
					else this.#feed({ type: "executor_failed", id: effect.id, error: errorText(error) });
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
		runner
			.run({
				id,
				script: effect.script,
				args: effect.args,
				computeMinutes: effect.compute_minutes,
				digest: effect.digest,
				outputSchema: (declaration?.output ?? {}) as Json,
			})
			.then(
				(result) =>
					this.#later(() => {
						const errors = declaration ? schemaErrors(declaration.output, result.output) : [];
						if (errors.length > 0) {
							this.#feed({ type: "script_failed", id, error: `output does not match its schema: ${errors.join("; ")}`, minutes: result.minutes });
						} else {
							this.#feed({ type: "script_returned", id, output: result.output, minutes: result.minutes });
						}
					}),
				(error: unknown) => this.#later(() => this.#feed({ type: "script_failed", id, error: errorText(error), minutes: 0 })),
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
		this.#sandbox?.dispose();
		this.#sandbox = null;
		this.#release();
	}
}
