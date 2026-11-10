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
// `LiveNode`, `SubmittableNode`), checked against the live core; the core
// checks them again when it applies the event.
//
// Agents are called through sessions: each call of a session continues the
// dialogue its previous call left. Every checkpoint of a call is written as
// a blob before `agent_progressed` names its digest; the core keeps the
// newest per attempt and passes it to the session's next call (`history`)
// or to a reissued attempt (`checkpoint`). The session's scratch dir
// (`work/<session>/scratch`) outlives its calls. Tools reached by agents or
// by the body (toolsets and MCP servers) are journaled, so nothing outside
// is called twice; preflight lists every tool source and warns about tools
// given to agents that may write outside.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { type ArtifactRef, type CommandFailure, type Json, type Refusal, type ToolDesc, type ToolFailure, Type } from "../sdk/index.ts";
import type { Declarations, Reply } from "../sdk/runtime.ts";
import { schemaErrors, toJson } from "../sdk/validate.ts";
import { ArtifactError, discardNode, mountedInput, type NodeDirs, nodeDirName, prepareNode, putBlob, resolveDrafts, verifyRefs } from "./artifacts.ts";
import type { CommandRunner } from "./commands.ts";
import { baseIdentity, bwrapAvailable, LAYOUT, resolveBins, SandboxError, sandboxDigest, Sandboxes } from "./confine.ts";
import { canonical } from "./render.ts";
import { putDialogue, readDialogue } from "./dialogues.ts";
import { commitLayer, layersAfter, type Work, xattrToolsMissing } from "./layers.ts";
import type { McpClient } from "@earendil-works/pi-mcp";
import { type Confinement, resolveAgentTools, sourceKey, type ToolInfo, ToolSources, writesOutside } from "./toolsets.ts";
import { bundleWorkflow } from "./bundle.ts";
import { HUMAN, IdleNode, LiveNode, must, OwnedRun, ResumableRun, SteerableNode, SubmittableNode } from "./capability.ts";
import { type BudgetKind, type CallAgentEffect, Core, type Effect, type Event, type InFlightDecision, type Outcome, type Pin, SEMANTICS, type Snapshot, type Usage } from "./core.ts";
import type { AgentSandbox, Executor, NodeSession, NodeSpec, TranscriptEntry } from "./executor.ts";
import { EventLog } from "./log.ts";
import { type Profile, resolveModels } from "./models.ts";
import { DeclarationError } from "./declarations.ts";
import { bindDigest, bindSnapshotDir, checkDevices, checkEnvironments, commandOutputsDir, storeCommandOutputs, type ResolvedVolume, resolveVolumes, snapshotBind, VolumeError } from "./volumes.ts";
import { type LocalProfile, loadProfile } from "./profile.ts";
import { renderInput, windowCheck } from "./render.ts";
import { Sandbox } from "./sandbox.ts";
import { acquireLock, type InboxEntry, newMessageId, readInbox, readMeta, refusePending, type RunPaths, runPaths } from "./store.ts";

export interface SessionOptions {
	/** The run directory. A directory without a log starts a new run. */
	readonly dir: string;
	/** Path to workflow.ts. Defaults to the one recorded for the run. */
	readonly workflow?: string;
	readonly executor: Executor;
	/** Runs command calls. Without one, every command call fails as `unrunnable`. */
	readonly commands?: CommandRunner;
	/**
	 * `auto` (default): bwrap sandboxes when bwrap works here; `require`:
	 * refuse without bwrap; `off`: no sandbox preflight and no bwrap (tests
	 * with fake commands; agents' `bash` reports it, toolsets and MCP servers
	 * run unconfined). Under `auto` without bwrap a local tool source is
	 * refused (`sandbox_unavailable`).
	 */
	readonly confine?: "auto" | "require" | "off";
	/** New runs: call-time binary paths (`--bin name=path`), beating the profile and the PATH. */
	readonly bins?: Readonly<Record<string, string>>;
	/** New runs: the caller's PATH, where unresolved binaries are found. Default: this process's PATH. */
	readonly callerPath?: string;
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
	/** Call-time host dirs for bind volumes (container target -> dir). A changed content digest misses the cache of the calls that bind it. */
	readonly volumes?: Readonly<Record<string, string>>;
	readonly profile?: Profile;
	/** The local profile (volumes, provider limits, slots). Defaults to the one on disk. */
	readonly local?: LocalProfile;
	/** Resume: raised limits, each logged as `budget_raised`. */
	readonly budget?: Readonly<Partial<Record<BudgetKind, number>>>;
	/** Who the session's own interventions (answers, cancel, unpause) come from. Default: the human. */
	readonly by?: string;
	/** Answers to idle nodes, sent once the body has replayed. */
	readonly sends?: readonly { readonly node: string; readonly text: string; readonly turns?: number }[];
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

/** The core refused the run as a whole (pin mismatch, path divergence, invalid declarations, unmet needs, invalid or missing volumes). */
export class RunRefused extends Error {
	override readonly name = "RunRefused";
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(`run refused: ${JSON.stringify(refusal)}`);
		this.refusal = refusal;
	}
}

/** A loop iteration's state, as logged: at most this many characters of its JSON (the whole one is a blob). */
const LOOP_STATE_CHARS = 2000;

/** The pin input of a toolset's bundle digest: `toolset:<path>`. */
const TOOLSET_PIN = "toolset:";
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
		const bundle = await bundleWorkflow(workflow);
		const session = new Session(paths, options, root, resolve(workflow), bundle.digest, release);
		await session.boot(bundle.code);
		return session;
	} catch (error) {
		release();
		// A refused boot answers the inbox entries waiting for this host.
		if (error instanceof RunRefused) refusePending(paths, error.refusal);
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
	/** Per node: the current executor turn. A result of an older turn (before a restart) is discarded. */
	readonly #generation = new Map<string, number>();
	#core = new Core();
	#sandbox: Sandbox | null = null;
	#decl!: Declarations;
	#local!: LocalProfile;
	/** Per sandbox: its volumes, resolved. */
	#volumes: Record<string, ResolvedVolume[]> = {};
	#boxes: Sandboxes | null = null;
	/** Per sandbox: its identity (declaration, binaries, bind volume content), part of command and agent node digests. */
	#sandboxDigests: Record<string, string> = {};
	/** Per node name: the digest of its definition, the first part of its journal key. */
	readonly #nodeDigests = new Map<string, string>();
	/** Command requests of this execution of the body, by id: their answers are parsed on delivery. */
	readonly #commandCalls = new Map<string, { command: string; input: Json; request: Extract<Event, { type: "requested" }> }>();
	/** Occurrences of each (node, input) in this execution of the body. */
	#occurrences = new Map<string, number>();
	/** Facts noted before the core started: logged right after `started`. */
	readonly #pendingFacts = new Map<string, Json>();
	#code = "";
	#input: Json = null;
	#seed = 0;
	/** Set when the code changed since the last session: hits so far, until the first new call. */
	#codeChange: { hits: number; reported: boolean } | null = null;
	/** When this host started: which host reused a journaled call (`hit` facts). */
	readonly #hostStarted = new Date().toISOString();
	/** A restarted held node: the body runs again, in a fresh VM, against the journal. */
	#restarting = false;
	/** Tool sources (toolsets, MCP servers), and every tool they listed at preflight, by source key. */
	#sources: ToolSources | null = null;
	/** Each toolset's bundle digest (pinned), by path: a custom tool's identity is (bundle digest, export). */
	#bundles: Readonly<Record<string, string>> = {};
	#listing = new Map<string, ToolInfo[]>();
	/** The body's connections: one per source for the run (this session). */
	readonly #bodyClients = new Map<string, Promise<McpClient>>();
	/** Interrupts the core sent for an attempt whose executor session is not open yet: by call, the attempt. */
	readonly #pendingInterrupts = new Map<string, number>();
	/** The core's decisions on tool calls in flight, as it emits them (read by `decideInFlight`). */
	readonly #decisions = new Map<string, InFlightDecision[]>();
	/** Aborts a command call in flight (restart, cancel). */
	readonly #commandAborts = new Map<string, AbortController>();
	#resumed = false;
	#settled = false;
	/** Nested `#feed`s in progress: the differential check runs when the outermost returns. */
	#feeding = 0;
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
	answer(node: IdleNode, text: string, messageId = newMessageId(), turns = 0): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		this.#seen.add(messageId);
		const refusal = this.#feed({ type: "sent", node: node.node.id, text, message_id: messageId, by: node.owned.by, turns })[0] ?? null;
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

	/**
	 * A message to an agent node: delivered now if the node is idle (the
	 * reply to its question, more turns, or after an interrupt), or queued as
	 * a steer after its current turn if it is running.
	 */
	send(owned: OwnedRun, id: string, text: string, messageId = newMessageId(), turns = 0): { readonly delivered: "reply" | "steer" } | { readonly refusal: Refusal } {
		const idle = IdleNode.check(owned, id);
		if (idle instanceof IdleNode) {
			const refusal = this.answer(idle, text, messageId, turns);
			return refusal ? { refusal } : { delivered: "reply" };
		}
		const running = SteerableNode.check(owned, id);
		if (running instanceof SteerableNode) {
			// More turns go to an idle node only: a running one has its allowance.
			if (turns > 0) return { refusal: { type: "not_idle", node: id } };
			const refusal = this.steer(running, text, messageId);
			return refusal ? { refusal } : { delivered: "steer" };
		}
		return { refusal: owned.snapshot.nodes.some((n) => n.id === id && n.type === "node_running") ? running : idle };
	}

	/** Aborts a running node's current turn, its tool calls included: it goes Idle(interrupted), progress kept. */
	interrupt(node: SteerableNode): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const id = node.node.id;
		// The core names the attempt it is for (`interrupt_turn`); the effect reaches that attempt only.
		return this.#feed({ type: "interrupt_requested", node: id, by: node.owned.by })[0] ?? null;
	}

	/**
	 * The orchestrator's `submit_result` for an orchestrator node, checked
	 * against its output schema. A mismatch is refused with the errors and
	 * the node stays pending.
	 */
	submit(node: SubmittableNode, value: unknown): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const target = node;
		const schema = this.#decl.orchestrators[target.node.name]?.output;
		const json = toJson(value);
		const errors = !json.ok ? json.errors : schemaErrors(schema, json.value);
		if (!json.ok || errors.length > 0) return { type: "invalid_answer", node: target.node.id, errors };
		try {
			verifyRefs(json.value, this.paths.dir);
		} catch (error) {
			if (error instanceof ArtifactError) return { type: "invalid_answer", node: target.node.id, errors: [error.message] };
			throw error;
		}
		const refusal = this.#feed({ type: "result_submitted", node: target.node.id, value: json.value, by: node.owned.by })[0] ?? null;
		this.#pump();
		this.#settle();
		return refusal;
	}

	/** Discards a node's progress and reissues its call with the original input and the note. Logged. */
	restart(node: LiveNode, note?: string, turns = 0): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const id = node.node.id;
		const held = this.#core.snapshot().held === id;
		// An unknown outcome is retried where it stopped (the core keeps the retry): its work dir stays.
		const retry = node.node.type === "node_idle" && node.node.cause.type === "outcome_unknown";
		if (!retry) {
			// The old session (or process) and dirs go first: the reissued call creates fresh ones.
			this.#nodes.get(id)?.session.interrupt?.();
			this.#commandAborts.get(id)?.abort();
			this.#closeNode(id);
			discardNode(this.paths.dir, id);
		}
		this.#transcriptLog(id)({ kind: "note", text: retry ? "restarted: the unknown call is made again" : `restarted${note === undefined ? "" : `: ${note}`}` });
		const refusal = this.#feed({ type: "restarted", node: id, note: note ?? null, by: node.owned.by, turns })[0] ?? null;
		// A held failure: the body had stopped on it, so it runs again.
		if (refusal === null && held) void this.#restartBody();
		this.#pump();
		this.#settle();
		return refusal;
	}

	/** Fails one node (an agent or a command) as a typed failure; the body handles it. */
	cancelNode(node: LiveNode): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const id = node.node.id;
		// A cancelled call ends its session's turn too: the next call continues from its newest checkpoint.
		const refusal = this.#feed({ type: "node_cancelled", node: id, by: node.owned.by })[0];
		if (refusal) return refusal;
		this.#pendingInterrupts.delete(id);
		// A start still pending is superseded: its session is closed when it opens.
		this.#generation.set(id, (this.#generation.get(id) ?? 0) + 1);
		this.#nodes.get(id)?.session.interrupt?.();
		this.#commandAborts.get(id)?.abort();
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
		this.#code = code;
		// The bundle as it runs, in the run's store under its digest (the pin's workflow_digest).
		if (putBlob(this.paths.dir, code) !== this.#digest) throw new Error("the workflow bundle's digest does not match its code");
		this.#sandbox = await this.#newSandbox();
		let decl: Declarations;
		try {
			decl = this.#sandbox.declare();
		} catch (error) {
			if (error instanceof DeclarationError) throw new RunRefused(error.refusal);
			throw error;
		}
		this.#decl = decl;
		this.#local = o.local ?? loadProfile(this.#root);
		try {
			// The caller's host dirs for bind volumes of a new run are noted, and reused by every later host of the run.
			const callTime = o.volumes ?? readMeta(this.paths)?.volumes;
			this.#volumes = resolveVolumes(decl.core.name, dirname(this.#workflow), decl.sandboxes, { root: this.#root, callTime, profile: this.#local.volumes });
			checkDevices(decl.sandboxes);
			checkEnvironments(decl);
			if (callTime !== undefined && Object.keys(callTime).length > 0) {
				const dirs = new Map(Object.values(this.#volumes).flat().map((v) => [v.target, v.dir]));
				this.#note("volumes", Object.fromEntries(Object.keys(callTime).map((t) => [t, dirs.get(t)!])));
			}
			this.#volumes = this.#snapshotBinds(this.#volumes);
		} catch (error) {
			if (error instanceof VolumeError) throw new RunRefused(error.refusal);
			throw error;
		}
		const inputs: Record<string, string> = Object.fromEntries(decl.pin.files.map((f) => [f, digestFile(resolve(this.#root, f))]));
		this.#prepareSandboxes(prior.length === 0);

		let input: Json;
		let seed: number;
		if (prior.length === 0) {
			this.#preflight();
			// Toolsets are bundled once, now: the bundles are blobs and their digests are pinned.
			for (const [path, digest] of Object.entries(await this.#preflightTools({}))) inputs[`${TOOLSET_PIN}${path}`] = digest;
			seed = o.seed ?? 0;
			const pin: Pin = {
				workflow_digest: this.#digest,
				prior_digests: [],
				models: resolveModels(decl.core.name, decl.models, { callTime: o.models, profile: o.profile ?? this.#local.models }),
				seed,
				inputs,
				semantics: SEMANTICS,
			};
			input = o.input ?? null;
			this.#refuseOn(this.#feed({ type: "started", workflow: decl.core as unknown as Json, pin, input }));
			this.#noteOrigin();
			this.#feed({ type: "executor_changed", name: o.executor.id });
			if (o.owner) this.#feed({ type: "claimed", owner: o.owner });
		} else {
			const first = prior[0]!;
			if (first.type !== "started") throw new Error(`log ${this.paths.log} does not begin with a started event`);
			this.#core = Core.refold(prior);
			this.#noteOrigin();
			for (const e of prior) if (e.type === "sent" || e.type === "steered") this.#seen.add(e.message_id);
			seed = o.seed ?? first.pin.seed;
			input = first.input;
			// The run's toolset bundles are its pinned ones, used as they are whatever the source is now.
			const pinned = Object.fromEntries(Object.entries(first.pin.inputs).flatMap(([k, v]) => (k.startsWith(TOOLSET_PIN) ? [[k.slice(TOOLSET_PIN.length), v]] : [])));
			for (const [path, digest] of Object.entries(pinned)) inputs[`${TOOLSET_PIN}${path}`] = digest;
			must(ResumableRun.check(this.#core, { workflow_digest: this.#digest, prior_digests: [], models: first.pin.models, seed, inputs, semantics: SEMANTICS }), refused);
			// Changed code is allowed: logged, and the body re-executes against the journal.
			const recorded = this.#core.snapshot().code[0];
			if (recorded !== undefined && recorded !== this.#digest && this.#core.snapshot().status.type !== "finished") {
				this.#feed({ type: "code_changed", from: recorded, to: this.#digest });
				// Names are labels: the new code's nodes are looked up in its own declarations.
				this.#refuseOn(this.#feed({ type: "workflow_declared", workflow: decl.core as unknown as Json }));
				this.#codeChange = { hits: 0, reported: false };
			}
			if (this.#core.snapshot().status.type === "finished") return this.#complete();
			await this.#preflightTools(pinned);
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

		this.#input = input;
		this.#seed = seed;
		this.#sandbox.start(input, seed);
		this.#pump();
		for (const [kind, limit] of Object.entries(o.budget ?? {})) {
			this.#feed({ type: "budget_raised", kind: kind as BudgetKind, limit: limit! });
		}
		this.#feed({ type: "retry_unavailable" });
		if (o.unpause && !this.#settled) this.#refuseOn([this.unpause(must(this.owned(by), refused))].filter((r) => r !== null));
		for (const s of o.sends ?? []) {
			const owned = must(this.owned(by), refused);
			const refusal = this.answer(must(IdleNode.check(owned, s.node), refused), s.text, undefined, s.turns ?? 0);
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

	/**
	 * Binaries (resolved for a new run, from run metadata on resume), then
	 * each sandbox's checks and setup unless confinement is off. Typed
	 * refusals: requires_missing, requires_broken, setup_failed, unknown_bin.
	 */
	#prepareSandboxes(fresh: boolean): void {
		const o = this.#options;
		const decls = this.#decl.sandboxes;
		const meta = readMeta(this.paths);
		try {
			const bins = fresh || !meta?.bins
				? resolveBins(this.#decl.core.name, decls, { callTime: o.bins, profile: this.#local.bins, path: o.callerPath ?? process.env.PATH })
				: Object.fromEntries(Object.entries(meta.bins).map(([n, b]) => [n, b.path]));
			const confine = o.confine ?? "auto";
			const can = confine !== "off" && bwrapAvailable();
			if (confine === "require" && !can) throw new Error("bubblewrap is required but cannot create a sandbox here");
			// A bind's snapshot digest is part of the cache key of every call that binds it.
			const bindDigests = Object.fromEntries(Object.entries(this.#volumes).map(([n, vs]) => [n, Object.fromEntries(vs.flatMap((v) => (v.kind === "bind" ? [[v.target, v.digest ?? bindDigest(v.dir)]] : [])))]));
			this.#sandboxDigests = Object.fromEntries(Object.entries(decls).map(([n, d]) => [n, sandboxDigest(d, bins, bindDigests[n] ?? {})]));
			this.#boxes = can ? new Sandboxes({ decls, bins, volumes: this.#volumes, bindDigests, root: resolve(this.#root) }) : null;
			const versions = this.#boxes ? this.#boxes.prepare((text) => process.stderr.write(`wallis: ${text}\n`)) : {};
			this.#note("bins", Object.fromEntries(Object.entries(bins).map(([n, path]): [string, Json] => [n, versions[n] === undefined ? { path } : { path, version: versions[n] }])));
			this.#note("base", meta?.base ?? baseIdentity());
			this.#note("confined", this.#boxes !== null);
			this.#note("answers", Object.fromEntries(Object.entries(this.#decl.orchestrators).map(([name, o]) => [name, o.output as unknown as Json])));
		} catch (error) {
			if (error instanceof SandboxError) throw new RunRefused(error.refusal);
			throw error;
		}
	}

	/**
	 * Preflight of the tool sources (with confinement off too: it only
	 * skips confinement): every declared source is listed; an agent's tool
	 * that no source offers is refused (`unknown_tool`), and so is a tool
	 * name an agent would see twice, or a built-in's (`tool_name_taken`);
	 * tools that may write
	 * outside, and tools a whole MCP server leaves out, are warnings, printed
	 * and recorded in run metadata.
	 */
	async #preflightTools(pinned: Readonly<Record<string, string>>): Promise<Record<string, string>> {
		// Unconfined only when confinement is explicitly off; without bubblewrap a local source is refused.
		const confinement: Confinement = this.#boxes ? { type: "bwrap", boxes: this.#boxes } : this.#options.confine === "off" ? { type: "off" } : { type: "unavailable" };
		this.#sources = new ToolSources({ decl: this.#decl, workflowDir: dirname(this.#workflow), runDir: this.paths.dir, confinement, pinned });
		if (this.#sources.sources().length === 0) return {};
		const bundles = await this.#sources.bundleAll();
		this.#bundles = bundles;
		try {
			this.#listing = await this.#sources.listAll();
		} catch (error) {
			if (error instanceof SandboxError) throw new RunRefused(error.refusal);
			throw error;
		}
		// What runs, for `describe`: a toolset is code from the project, bundled once per run.
		if (Object.keys(bundles).length > 0) this.#note("toolsets", bundles);
		const writes: Record<string, string[]> = {};
		for (const [agent, a] of Object.entries(this.#decl.agents)) {
			const resolved = resolveAgentTools(agent, a.tools, this.#listing);
			if (resolved.unknown !== null) throw new RunRefused({ type: "unknown_tool", name: resolved.unknown });
			if (resolved.taken !== null) throw new RunRefused({ type: "tool_name_taken", agent, name: resolved.taken });
			for (const w of resolved.warnings) this.#warn(w);
			for (const t of resolved.tools) if (writesOutside(t.annotations)) (writes[t.id] ??= []).push(agent);
		}
		// Who holds a tool that may write outside, for `describe`.
		this.#note("writes", writes);
		return bundles;
	}

	/** A warning about tools: printed, and noted once (run metadata). */
	#warn(text: string): void {
		const warnings = (this.#fact("warnings") as string[] | undefined) ?? [];
		if (warnings.includes(text)) return;
		process.stderr.write(`wallis: warning: ${text}\n`);
		this.#note("warnings", [...warnings, text]);
	}

	/**
	 * A host fact, logged as `noted` when it changes (`meta.json` is derived
	 * from these). Before the core has started (preflight of a new run) it is
	 * kept, and logged right after `started`.
	 */
	#note(key: string, value: Json): void {
		if (this.#core.snapshot().status === null) {
			this.#pendingFacts.set(key, value);
			return;
		}
		if (canonical(this.#fact(key) ?? null) === canonical(value) && this.#fact(key) !== undefined) return;
		this.#feed({ type: "noted", key, value });
	}

	#fact(key: string): Json | undefined {
		if (this.#core.snapshot().status === null) return this.#pendingFacts.get(key);
		return this.#core.facts()[key];
	}

	/** Logs the facts kept before the core started, and where the run comes from. */
	#noteOrigin(): void {
		const meta = readMeta(this.paths);
		this.#note("workflow", this.#workflow);
		this.#note("root", resolve(this.#root));
		this.#note("executor", this.#options.executorModule ?? meta?.executor ?? null);
		if (this.#fact("created") === undefined) this.#note("created", meta?.created ?? new Date().toISOString());
		for (const [key, value] of this.#pendingFacts) this.#note(key, value);
		this.#pendingFacts.clear();
	}

	/** A body tool, by id, from the preflight listing. */
	#bodyTool(id: string): ToolInfo | undefined {
		for (const tools of this.#listing.values()) for (const t of tools) if (t.id === id) return t;
		return undefined;
	}

		#agentSandbox(name: string | null, dirs: NodeDirs): AgentSandbox {
		if (name === null) return { type: "none" };
		const boxes = this.#boxes;
		if (!boxes) return { type: "unavailable", name, reason: "confinement is off or bubblewrap cannot create a sandbox here" };
		const overlay = dirs.work === null ? undefined : { lowers: dirs.work.lowers, ovl: dirs.work.ovl };
		return { type: "bwrap", name, spawn: (argv) => boxes.spawn(name, argv, { scratch: dirs.scratch, inputs: dirs.inputs, ...(overlay ? { overlay } : {}), trees: dirs.trees }) };
	}

	/**
	 * Each bind volume as its snapshot in the run: taken now for a new run
	 * (or a fork), and reused by every later host of the run, so an edit to
	 * a host dir while the run goes on never reaches it. A noted snapshot
	 * the run no longer has is refused (`volume_missing`), never retaken.
	 */
	#snapshotBinds(volumes: Record<string, ResolvedVolume[]>): Record<string, ResolvedVolume[]> {
		const taken: Record<string, string> = { ...(readMeta(this.paths)?.binds ?? {}) };
		const out = Object.fromEntries(
			Object.entries(volumes).map(([sandbox, vs]) => [
				sandbox,
				vs.map((v): ResolvedVolume => {
					if (v.kind !== "bind") return v;
					const digest = (taken[v.dir] ??= snapshotBind(this.paths.dir, v.dir));
					const dir = bindSnapshotDir(this.paths.dir, digest);
					if (!existsSync(dir)) throw new VolumeError({ type: "volume_missing", sandbox, target: v.target, path: dir });
					return { kind: "bind", target: v.target, dir, digest };
				}),
			]),
		);
		if (Object.keys(taken).length > 0) this.#note("binds", taken);
		return out;
	}

	#nodeVolumes(sandbox: string | null): readonly ResolvedVolume[] {
		return sandbox === null ? [] : (this.#volumes[sandbox] ?? []);
	}

	#preflight(): void {
		// A workspace's overlay is emulated for the host's file tools with the xattr tools (opaque dirs).
		if (Object.values(this.#decl.agents).some((a) => a.access > 0)) {
			const missing = xattrToolsMissing();
			if (missing !== null) throw new RunRefused({ type: "requires_missing", name: missing });
		}
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
			case "send": {
				const sent = this.send(owned, entry.node, entry.text, entry.id, entry.turns ?? 0);
				return "refusal" in sent ? sent.refusal : null;
			}
			case "interrupt": {
				const node = SteerableNode.check(owned, entry.node);
				return node instanceof SteerableNode ? this.interrupt(node) : node;
			}
			case "submit": {
				const node = SubmittableNode.check(owned, entry.node);
				return node instanceof SubmittableNode ? this.submit(node, entry.value) : node;
			}
			case "restart":
			case "cancel_node": {
				const node = LiveNode.check(owned, entry.node);
				if (!(node instanceof LiveNode)) return node;
				return entry.type === "restart" ? this.restart(node, entry.note, entry.turns ?? 0) : this.cancelNode(node);
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
		this.#feeding++;
		try {
			const effects = this.#core.step(event);
			this.#noteCodeChange(event, effects);
			this.#noteHit(event, effects);
			for (const effect of effects) {
				if (effect.type === "refuse" && effect.id === null) refusals.push(effect.refusal);
				else this.#handle(effect, event);
			}
		} finally {
			this.#feeding--;
		}
		if (this.#feeding === 0) this.#differential(event);
		return refusals;
	}

	/**
	 * Tests only (`WALLIS_DIFFERENTIAL=1`): after every event, the run state
	 * rebuilt from the log, as the CLI and MCP see it (`inspectRun`), must
	 * equal the live state. A mismatch is a state change that was not
	 * logged; it ends the session.
	 */
	#differential(event: Event): void {
		if (process.env.WALLIS_DIFFERENTIAL !== "1" || this.#settled) return;
		const rebuilt = Core.refold(this.#log.read()).fullState();
		const live = this.#core.fullState();
		if (rebuilt === live) return;
		const error = new Error(`differential check: after ${event.type}, the state rebuilt from the log differs from the live state\nlive:    ${live}\nrebuilt: ${rebuilt}`);
		process.stderr.write(`wallis: ${error.message}\n`);
		this.#abort(error);
	}

	#pump(): void {
		while (!this.#settled && (this.#deliveries.length > 0 || this.#requests.length > 0)) {
			const delivery = this.#deliveries.shift();
			if (delivery) {
				// A result for an earlier execution of the body is in the journal; the current one hits it.
				if (!this.#sandbox!.deliver(delivery[0], delivery[1] as unknown as Json)) this.#transcriptLog(delivery[0])({ kind: "note", text: "result journaled; no current request waited for it" });
				continue;
			}
			let event = this.#requests.shift()!;
			if (event.type === "observed") event = this.#loopState(event);
			if (event.type === "requested") {
				const invalid = this.#invalidRequest(event.request);
				if (invalid) {
					// Rejected at the boundary: the body gets a typed error and nothing is logged.
					this.#deliveries.push([event.id, invalid]);
					continue;
				}
				event = this.#keyed(event);
			}
			const refusals = this.#feed(event);
			// A request the core refuses as an event is a path divergence: the body took another path.
			if (refusals.length > 0) throw new RunRefused(refusals[0]!);
		}
	}

	/**
	 * A loop iteration's state, as logged: whole up to LOOP_STATE_CHARS of
	 * JSON; a longer one truncated, with the whole state a blob in the run's
	 * store (`full`), for `wallis tree --full`.
	 */
	#loopState(event: Extract<Event, { type: "observed" }>): Event {
		const value = event.value as { state?: Json } | null;
		if (!event.label.startsWith("loop ") || value === null || typeof value !== "object" || !("state" in value)) return event;
		const text = JSON.stringify(value.state ?? null);
		if (text.length <= LOOP_STATE_CHARS) return event;
		return { ...event, value: { ...(value as Record<string, Json>), state: { truncated: text.slice(0, LOOP_STATE_CHARS) }, full: putBlob(this.paths.dir, text) } };
	}

	/**
	 * What a node is, for its digest: its definition, never its name or its
	 * sandbox's name (labels only). A sandbox is its digest (declaration,
	 * binaries, bind volume content); a custom tool is (bundle digest,
	 * export); an MCP tool is (server, tool). An undeclared node has no
	 * definition (null): the core refuses it.
	 */
	#definition(r: { type: string; agent?: string; command?: string; tool?: string; name?: string }): Json {
		const env = (sandbox: string | null | undefined) => (sandbox ? (this.#sandboxDigests[sandbox] ?? null) : null);
		switch (r.type) {
			case "call": {
				const a = this.#decl.agents[r.agent!];
				if (!a) return null;
				const { sandbox, tools, ...rest } = a;
				return { kind: "agent", ...(rest as unknown as Record<string, Json>), tools: tools.map((t) => this.#toolIdentity(t)), env: env(sandbox) };
			}
			case "command": {
				const c = this.#decl.commands[r.command!];
				if (!c) return null;
				const { sandbox, description: _label, ...rest } = c;
				return { kind: "command", ...(rest as unknown as Record<string, Json>), env: env(sandbox) };
			}
			case "tool":
				return { kind: "tool", tool: this.#toolIdentity(r.tool!) };
			default: {
				const o = this.#decl.orchestrators[r.name!];
				return o ? { kind: "orchestrator", ...(o as unknown as Record<string, Json>) } : null;
			}
		}
	}

	/**
	 * A tool's identity: a custom tool by its toolset's bundle digest and
	 * export, and where it runs (its sandbox's digest: declaration, binaries,
	 * bind volume content; and its network), so editing data bound into its
	 * sandbox misses; an MCP tool by server and tool.
	 */
	#toolIdentity(tool: ToolDesc | string): Json {
		const custom = (path: string, name: string): Json => {
			const t = this.#decl.toolsets[path];
			return { kind: "custom", bundle: this.#bundles[path] ?? null, export: name, env: t ? (this.#sandboxDigests[t.sandbox] ?? null) : null, network: t?.network ?? null };
		};
		if (typeof tool === "string") {
			// A body tool: its listed source, not its id's text.
			const info = this.#bodyTool(tool);
			if (!info) return { kind: "unlisted", id: tool };
			return info.source.kind === "toolset" ? custom(info.source.path, info.remote) : { kind: "mcp_tool", server: info.source.server, tool: info.remote };
		}
		return tool.kind === "custom" ? custom(tool.toolset, tool.export) : (tool as unknown as Json);
	}

	/**
	 * The journal key of a request: its node's definition digest, and its
	 * occurrence among calls with the same node, session and input in its
	 * branch of this execution of the body.
	 */
	#keyed(event: Extract<Event, { type: "requested" }>): Event {
		const r = event.request as { type: string; agent?: string; command?: string; tool?: string; name?: string; input?: Json };
		const name = r.type === "call" ? `agent:${r.agent}` : r.type === "command" ? `command:${r.command}` : r.type === "tool" ? `tool:${r.tool}` : `orchestrator:${r.name}`;
		let digest = r.type === "command" ? this.#commandDigest(r.command!, r.input ?? null) : this.#nodeDigests.get(name);
		if (digest === undefined) {
			digest = createHash("sha256").update(canonical(JSON.parse(JSON.stringify(this.#definition(r))) as Json)).digest("hex");
			this.#nodeDigests.set(name, digest);
		}
		// Counted per branch (the id's path): within one branch calls are made in program order, so
		// the count never depends on the order other branches' results arrive in.
		const branch = event.id.slice(0, event.id.lastIndexOf("#"));
		const session = r.type === "call" ? ((event.request as { session?: Json }).session ?? null) : null;
		const key = `${branch}\n${digest}\n${canonical(session)}\n${canonical(r.input ?? null)}`;
		const n = this.#occurrences.get(key) ?? 0;
		this.#occurrences.set(key, n + 1);
		const occurrence = `${branch}/${n}`;
		// A body tool call carries whether it may be made again after a crash.
		const request = r.type === "tool" ? { ...(event.request as object), replay: this.#bodyTool(r.tool!)?.replay === "safe" ? "replay_safe" : "replay_never" } : event.request;
		const keyed: Extract<Event, { type: "requested" }> = { ...event, request: request as Json, node_digest: digest, occurrence };
		// A command's answer is its process result, parsed by the current `parse` when it is delivered.
		if (r.type === "command") this.#commandCalls.set(event.id, { command: r.command!, input: r.input ?? null, request: keyed });
		return keyed;
	}

	/**
	 * A command call's node digest: what it runs, not its code's text (which
	 * misses the constants the code reads): the argv its `run` computes for
	 * this input (or why it cannot), and its sandbox's digest (declaration,
	 * binaries, bind volume content). `parse` is not in it: the journal keeps
	 * the process result, and the current `parse` is applied on every
	 * delivery. The compute budget left (`WALLIS_COMPUTE_MINUTES`) is not
	 * either.
	 */
	#commandDigest(command: string, input: Json): string {
		const declaration = this.#decl.commands[command];
		const argv: { ok: true; argv: readonly string[] } | { ok: false; error: string } = declaration
			? this.#sandbox!.argv(command, mountedInput(input, LAYOUT.inputs, declaration.input))
			: { ok: false, error: `no command ${command}` };
		const definition = { kind: "command", argv: argv.ok ? argv.argv : { error: argv.error }, env: declaration ? (this.#sandboxDigests[declaration.sandbox] ?? null) : null };
		return createHash("sha256").update(canonical(definition as Json)).digest("hex");
	}

	/**
	 * A request answered from the journal (a hit: answered, nothing else) is
	 * logged as a host fact, `hit <id>`: what was reused, and by which host
	 * (its start time). A fact, not the run: it never changes the run's
	 * state, so a resumed run still equals an uninterrupted one.
	 */
	#noteHit(event: Event, effects: readonly Effect[]): void {
		if (event.type !== "requested" || effects.length !== 1 || effects[0]!.type !== "deliver") return;
		const r = event.request as { type: string; agent?: string; command?: string; tool?: string; name?: string };
		const node = r.agent ?? r.command ?? r.tool ?? r.name ?? null;
		this.#note(`hit ${event.id}`, { kind: r.type, node, host: this.#hostStarted });
	}

	/** After a code change: count hits, and say where the first new call is. */
	#noteCodeChange(event: Event, effects: readonly Effect[]): void {
		const c = this.#codeChange;
		if (!c || c.reported || event.type !== "requested") return;
		const issued = effects.find((e) => e.type === "call_agent" || e.type === "run_command");
		if (!issued) {
			if (!effects.some((e) => e.type === "checkpoint")) c.hits++;
			return;
		}
		c.reported = true;
		const node = issued.type === "call_agent" ? issued.agent : issued.command;
		process.stderr.write(`wallis: code changed; ${c.hits} calls reused, first new call: ${node} at ${event.id}\n`);
	}

	/** Runs the body again in a fresh VM: completed calls hit the journal, the restarted node's call waits for its new result. */
	async #restartBody(): Promise<void> {
		this.#restarting = true;
		try {
			// The new VM is built first; the old one stays usable (parse, deliveries) until the swap.
			const next = await this.#newSandbox();
			this.#later(() => {
				const old = this.#sandbox;
				this.#sandbox = next;
				old?.dispose();
				this.#requests.length = 0;
				this.#deliveries.length = 0;
				this.#occurrences = new Map();
				this.#restarting = false;
				this.#sandbox.start(this.#input, this.#seed);
			});
		} catch (error) {
			this.#abort(error);
		}
	}

	#newSandbox(): Promise<Sandbox> {
		return Sandbox.create(this.#code, {
			send: (json) => this.#requests.push(JSON.parse(json) as Event),
			done: (json) => this.#requests.push({ type: "body_finished", output: JSON.parse(json) as Json }),
			fail: (json) => this.#requests.push({ type: "body_failed", reason: JSON.parse(json) }),
		});
	}

	#invalidRequest(request: Json): Reply | null {
		const r = request as { type: string; agent?: string; input?: Json; command?: string; tool?: string; name?: string };
		const fail = (subject: string, errors: string[]): Reply | null => (errors.length > 0 ? { type: "schema", subject, errors } : null);
		switch (r.type) {
			case "call": {
				const agent = this.#decl.agents[r.agent!];
				return agent ? fail(`input of agent ${r.agent}`, schemaErrors(agent.input, r.input)) : null;
			}
			case "command": {
				const command = this.#decl.commands[r.command!];
				return command ? fail(`input of command ${r.command}`, schemaErrors(command.input, r.input)) : null;
			}
			case "tool": {
				const tool = this.#bodyTool(r.tool!);
				if (!tool) return { type: "refuse", refusal: { type: "unknown_tool", name: r.tool! } };
				return fail(`input of tool ${r.tool}`, schemaErrors(tool.inputSchema, r.input));
			}
			case "orchestrator": {
				const node = this.#decl.orchestrators[r.name!];
				return node ? fail(`input of orchestrator node ${r.name}`, schemaErrors(node.input, r.input)) : null;
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
			case "run_command":
				this.#runCommand(effect);
				return;
			case "call_tool":
				this.#callTool(effect);
				return;
			case "interrupt_turn": {
				// Only the attempt the core names: an earlier one opening late never takes it.
				const open = this.#nodes.get(effect.id);
				if (open && open.attempt === effect.attempt) open.session.interrupt?.();
				else this.#pendingInterrupts.set(effect.id, effect.attempt);
				return;
			}
			case "in_flight_decided":
				this.#decisions.set(effect.id, effect.decisions);
				return;
			case "log_unknown_tool":
				// Stepped next, so the log (and every state rebuilt from it) has the unknown outcome.
				this.#transcriptLog(effect.id)({ kind: "note", text: "in flight at a crash and not safe to make again: its outcome is unknown" });
				this.#requests.push({ type: "tool_call_unknown", id: effect.id });
				return;
			case "deliver": {
				const command = this.#commandCalls.get(effect.id);
				if (command) return this.#deliverCommand(effect.id, command, effect.value);
				this.#deliveries.push([effect.id, { type: "deliver", value: effect.value }]);
				return;
			}
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
	/**
	 * A command's answer, as the journal keeps it: `{ result, output }`,
	 * the process result (exit, stdout, stderr, and the files it wrote, by
	 * digest in `<run>/outputs/`) and its parse as recorded (for views and
	 * exports). The current `parse` is applied to the result, so a changed
	 * `parse` never needs a rerun and is never stale. When it no longer
	 * accepts the result, the call is forgotten and runs again (where a
	 * failure is held as usual).
	 */
	#deliverCommand(id: string, call: { command: string; input: Json; request: Extract<Event, { type: "requested" }> }, value: Json): void {
		const recorded = value as { result?: { exit: number; stdout: string; stderr: string; files: string | null } } | null;
		const result = recorded !== null && typeof recorded === "object" && !Array.isArray(recorded) ? recorded.result : undefined;
		// An answer journaled before process results were kept: as it was.
		if (result === undefined) return void this.#deliveries.push([id, { type: "deliver", value }]);
		const declaration = this.#decl.commands[call.command]!;
		const input = mountedInput(call.input, LAYOUT.inputs, declaration.input);
		const parsed = this.#parseCommand(call.command, result, input, result.files === null ? null : commandOutputsDir(this.paths.dir, result.files));
		if (parsed.ok) return void this.#deliveries.push([id, { type: "deliver", value: parsed.value }]);
		this.#transcriptLog(id)({ kind: "note", text: `the current parse does not accept the journaled result (${parsed.failure.type}); running the command again` });
		this.#commandCalls.delete(id);
		queueMicrotask(() =>
			this.#later(() => {
				this.#refuseOn(this.#feed({ type: "call_forgotten", node: id, by: this.#core.snapshot().owner ?? HUMAN }));
				this.#requests.push(call.request);
				this.#pump();
			}),
		);
	}

	/** A process result through the command's current `parse` and output check; files come from `files`. */
	#parseCommand(command: string, result: { exit: number; stdout: string; stderr: string }, input: Json, files: string | null): { ok: true; value: Json } | { ok: false; failure: CommandFailure } {
		const declaration = this.#decl.commands[command]!;
		const parsed = this.#sandbox!.parse(command, { exit: result.exit, stdout: result.stdout, stderr: result.stderr }, input);
		if (!parsed.ok) return { ok: false, failure: { type: "output_mismatch", errors: [`parse: ${parsed.error}`] } };
		const out = this.#parseOutput(parsed.output, declaration.output, files);
		if (out.ok) return out;
		return { ok: false, failure: out.missing === undefined ? { type: "output_mismatch", errors: [out.error] } : { type: "missing_file", name: out.missing } };
	}

	#parseOutput(output: unknown, schema: unknown, scratch: string | Work | null): { ok: true; value: Json } | { ok: false; error: string; missing?: string } {
		const json = toJson(output);
		if (!json.ok) return { ok: false, error: `output is not JSON: ${json.errors.join("; ")}` };
		let value: Json;
		try {
			value = resolveDrafts(json.value, this.paths.dir, scratch);
			verifyRefs(value, this.paths.dir);
		} catch (error) {
			if (error instanceof ArtifactError) return error.missing === undefined ? { ok: false, error: error.message } : { ok: false, error: error.message, missing: error.missing };
			throw error;
		}
		const errors = schemaErrors(schema, value);
		return errors.length > 0 ? { ok: false, error: `output does not match its schema: ${errors.join("; ")}` } : { ok: true, value };
	}

	/** The node's open executor session, kept while the node is idle. */
	readonly #nodes = new Map<string, { session: NodeSession; model: string; attempt: number }>();

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

		// A session call continues its previous call's dialogue, and a reissued attempt its newest
		// checkpoint: blobs the journal names. A missing one is refused, never a fresh start.
		const history = effect.history === null ? null : readDialogue(this.paths.dir, effect.history);
		const resume = effect.checkpoint === null ? null : readDialogue(this.paths.dir, effect.checkpoint);
		/** This attempt's newest checkpoint: the session's dialogue after it, named when it returns. */
		let newest: string | null = effect.checkpoint;
		if (history === undefined || resume === undefined) {
			log({ kind: "note", text: `a dialogue blob the journal names is missing (${effect.history ?? ""} ${effect.checkpoint ?? ""})` });
			queueMicrotask(() => this.#later(() => this.#feed({ type: "previous_dialogue_missing", id })));
			return;
		}
		let workspace: NodeDirs;
		try {
			// The call's /w: its session's layers, with its own upper dir on top.
			workspace = prepareNode(this.paths.dir, id, effect.input, declaration.input, this.#nodeVolumes(declaration.sandbox), effect.layers, effect.attempt);
		} catch (error) {
			if (!(error instanceof ArtifactError)) throw error;
			return failed(error.message);
		}
		// The input as the agent reads it: each artifact with its path in the sandbox (`/in/<hex>/<name>`), each Tree with its mount.
		const rendered = renderInput(declaration.input, mountedInput(effect.input, LAYOUT.inputs, declaration.input));
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
			turn: effect.turn,
			turnLimit: effect.turn_limit,
			// The blob first, then the event naming it, synchronously: a crash in between leaves an unreferenced blob.
			checkpoint: (state) => {
				if (!current()) return;
				// A delta from the session's dialogue before the call, where it extends it.
				const dialogue = putDialogue(this.paths.dir, state, effect.history !== null && history !== null ? { digest: effect.history, state: history } : null);
				newest = dialogue;
				this.#later(() => this.#feed({ type: "agent_progressed", id, dialogue }));
			},
			resume,
			slot: effect.slot,
			transcript: message === undefined ? effect.transcript : effect.transcript.slice(0, -1),
			history,
			recorded: new Map(effect.recorded.map((r) => [r.call, r.result])),
			// The core decides (and logs) what happens to each; nothing is decided here.
			decideInFlight: (calls) => {
				this.#decisions.delete(id);
				if (!current()) return { refused: { type: "node_not_running", node: id } };
				let refused: Refusal | undefined;
				this.#later(() => {
					refused = this.#feed({ type: "tool_calls_in_flight", id, calls: [...calls] })[0];
				});
				const decisions = this.#decisions.get(id);
				// The core refused: its typed refusal, never a decision made here.
				if (refused !== undefined || decisions === undefined) return { refused: refused ?? { type: "node_not_running", node: id } };
				return { decisions };
			},
			// Journaled before the model sees it; a result of a restarted call is dropped by the core.
			record: (call, result) => {
				if (current()) this.#later(() => this.#feed({ type: "tool_recorded", id, call, result }));
			},
			outputSchema: declaration.output as unknown as Json,
			workspace,
			sandbox: this.#agentSandbox(declaration.sandbox, workspace),
			exportArtifact: (path, media, name) =>
				resolveDrafts(name === undefined ? { artifact: path, media } : { artifact: path, media, name }, this.paths.dir, workspace.work ?? workspace.scratch) as unknown as ArtifactRef,
			connect: (source) => this.#sources!.connect(source),
			warn: (text) => {
				log({ kind: "note", text: `warning: ${text}` });
				this.#warn(text);
			},
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
			// Restarted or cancelled while it started: it is not the node's session, and takes no interrupt.
			if (!current()) {
				started.close();
				throw new Error("superseded while starting");
			}
			this.#nodes.set(id, { session: started, model: effect.model, attempt: effect.attempt });
			return started;
		};
		if (message !== undefined) log({ kind: "user", text: message });
		session()
			.then((s) => {
				// An interrupt the core sent for this attempt before it opened.
				if (this.#pendingInterrupts.get(id) === effect.attempt) {
					this.#pendingInterrupts.delete(id);
					s.interrupt?.();
				}
				return s.turn(message, effect.turn_limit);
			})
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
						switch (turn.type) {
							case "ended":
								this.#feed({ type: "agent_idle", ...base, message: turn.message, usage });
								return;
							case "asked":
								this.#feed({ type: "agent_asked", ...base, message: turn.message, usage });
								return;
							case "outcome_unknown":
								this.#feed({ type: "call_outcome_unknown", ...base, tool: turn.tool, args: turn.args, usage });
								return;
							case "interrupted":
								this.#feed({ type: "turn_interrupted", ...base, usage });
								return;
							case "turn_limit":
								this.#feed({ type: "turn_limit_reached", ...base, used: turn.used, limit: turn.limit, usage });
								return;
							case "agent_error":
								this.#feed({ type: "agent_failed", ...base, failure: turn.failure, usage });
								done();
								return;
							case "submitted": {
								const parsed = this.#parseOutput(turn.output, declaration.output, workspace.work ?? workspace.scratch);
								if (parsed.ok) {
									// The call's changes become a layer, written before the event that names it.
									const committed = workspace.work === null ? null : commitLayer(this.paths.dir, workspace.work, workspace.root, effect.attempt);
									const layers = layersAfter(this.paths.dir, effect.layers, committed);
									this.#feed({ type: "agent_returned", ...base, output: parsed.value, usage, dialogue: newest, layers });
								}
								else this.#feed({ type: "agent_failed", ...base, failure: { type: "gave_up", error: parsed.error }, usage });
								done();
							}
						}
					}),
				(error: unknown) =>
					this.#later(() => {
						if (!current()) return;
						this.#closeNode(id);
						this.#feed({ type: "executor_failed", id, error: errorText(error) });
					}),
			);
	}

	/**
	 * A body tool call (a toolset tool or an MCP tool), over the run's
	 * connection to its source. The output is its `structuredContent`,
	 * checked against its `outputSchema`, or else its text. Every failure is
	 * a typed `ToolFailure`; the result is journaled.
	 */
	#callTool(effect: Extract<Effect, { type: "call_tool" }>): void {
		const id = effect.id;
		const info = this.#bodyTool(effect.tool);
		const generation = (this.#generation.get(id) ?? 0) + 1;
		this.#generation.set(id, generation);
		const current = () => this.#generation.get(id) === generation;
		const log = this.#transcriptLog(id);
		const failed = (failure: ToolFailure) => this.#feed({ type: "tool_failed", id, failure });
		if (!info) return queueMicrotask(() => this.#later(() => failed({ type: "tool_unreachable", error: `no tool ${effect.tool} at preflight` })));
		this.#commandAborts.get(id)?.abort();
		const abort = new AbortController();
		this.#commandAborts.set(id, abort);
		log({ kind: "tool_call", tool: info.id, args: effect.input });
		const key = sourceKey(info.source);
		let client = this.#bodyClients.get(key);
		if (!client) {
			client = this.#sources!.connect(info.source);
			this.#bodyClients.set(key, client);
		}
		client
			.then((c) => c.callTool(info.remote, effect.input as Record<string, unknown>, { signal: abort.signal }))
			.then(
				(r) =>
					this.#later(() => {
						if (this.#commandAborts.get(id) === abort) this.#commandAborts.delete(id);
						if (!current()) return log({ kind: "note", text: "discarded the result of a tool call that was restarted or cancelled" });
						const content = (r.content ?? []) as { type: string; text?: string }[];
						const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
						log({ kind: "tool_result", tool: info.id, result: (r.structuredContent ?? text) as Json, isError: r.isError === true });
						if (r.isError === true) return failed({ type: "tool_error", message: text.slice(0, 2000) });
						const output = info.outputSchema === null ? (r.structuredContent ?? text) : r.structuredContent;
						const out = this.#parseOutput(output, info.outputSchema ?? {}, null);
						if (out.ok) this.#feed({ type: "tool_returned", id, output: out.value });
						else failed({ type: "tool_output_mismatch", errors: [out.error] });
					}),
				(error: unknown) =>
					this.#later(() => {
						if (this.#commandAborts.get(id) === abort) this.#commandAborts.delete(id);
						if (!current()) return;
						failed({ type: "tool_unreachable", error: errorText(error) });
					}),
			);
	}

	/**
	 * A command call: its argv from the command's pure `run` (in the workflow
	 * VM, on the mounted input), the process in its sandbox, then its pure
	 * `parse`; files it names must exist in its scratch dir; the output is
	 * checked against the schema. Every failure is a typed `CommandFailure`.
	 */
	#runCommand(effect: Extract<Effect, { type: "run_command" }>): void {
		const id = effect.id;
		const declaration = this.#decl.commands[effect.command]!;
		const generation = (this.#generation.get(id) ?? 0) + 1;
		this.#generation.set(id, generation);
		const current = () => this.#generation.get(id) === generation;
		const failed = (failure: CommandFailure, minutes = 0) => this.#feed({ type: "command_failed", id, failure, minutes });
		const later = (step: () => void) => queueMicrotask(() => this.#later(step));
		const runner = this.#options.commands;
		if (!runner) return later(() => failed({ type: "unrunnable", error: "no command runner" }));
		let workspace: NodeDirs;
		try {
			workspace = prepareNode(this.paths.dir, id, effect.input, declaration.input, this.#nodeVolumes(declaration.sandbox));
		} catch (error) {
			return later(() => failed({ type: "unrunnable", error: errorText(error) }));
		}
		const input = mountedInput(effect.input, LAYOUT.inputs, declaration.input);
		const argv = this.#sandbox!.argv(effect.command, input);
		if (!argv.ok) return later(() => failed({ type: "unrunnable", error: `run: ${argv.error}` }));
		this.#commandAborts.get(id)?.abort();
		const abort = new AbortController();
		this.#commandAborts.set(id, abort);
		const env: Record<string, string> = effect.compute_minutes === null ? {} : { WALLIS_COMPUTE_MINUTES: String(effect.compute_minutes) };
		const spawn = this.#boxes?.spawn(declaration.sandbox, argv.argv, { scratch: workspace.scratch, inputs: workspace.inputs, trees: workspace.trees }, { gpu: (declaration.resources.gpu ?? 0) > 0, env }) ?? null;
		const log = this.#transcriptLog(id);
		log({ kind: "note", text: `argv: ${JSON.stringify(argv.argv)}` });
		const done = () => {
			if (this.#commandAborts.get(id) === abort) this.#commandAborts.delete(id);
			discardNode(this.paths.dir, id);
		};
		runner
			.run({ id, command: effect.command, input, argv: argv.argv, spawn, computeMinutes: effect.compute_minutes, resources: declaration.resources, workspace, signal: abort.signal })
			.then(
				(r) =>
					this.#later(() => {
						if (!current()) return log({ kind: "note", text: "discarded the result of a command that was restarted or cancelled" });
						log({ kind: "turn", result: `exit ${r.exit}${r.timedOut ? " (timed out)" : ""}` });
						if (r.timedOut) failed({ type: "timed_out", minutes: r.minutes }, r.minutes);
						else if (r.exit !== 0) failed({ type: "exit_code", code: r.exit, stderr_head: r.stderr.trim().slice(-500) }, r.minutes);
						else {
							// The files it wrote are kept by digest, so a later `parse` can read them too.
							const files = storeCommandOutputs(this.paths.dir, workspace.scratch);
							const result = { exit: r.exit, stdout: r.stdout, stderr: r.stderr, files };
							const parsed = this.#parseCommand(effect.command, result, input, files === null ? null : commandOutputsDir(this.paths.dir, files));
							if (parsed.ok) this.#feed({ type: "command_returned", id, output: { result, output: parsed.value }, minutes: r.minutes });
							else failed(parsed.failure, r.minutes);
						}
						done();
					}),
				(error: unknown) =>
					this.#later(() => {
						if (!current()) return;
						failed({ type: "unrunnable", error: errorText(error) });
						done();
					}),
			);
	}

	/** Ends the session once nothing is queued and the run no longer runs. */
	#settle(): void {
		if (this.#settled || this.#restarting || this.#requests.length > 0 || this.#deliveries.length > 0) return;
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
		for (const client of this.#bodyClients.values()) void client.then((c) => c.close()).catch(() => {});
		for (const id of [...this.#nodes.keys()]) this.#closeNode(id);
		this.#sandbox?.dispose();
		this.#sandbox = null;
		this.#release();
	}
}
