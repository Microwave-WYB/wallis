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
import type { ArtifactRef, CommandFailure, Json, Refusal } from "../sdk/index.ts";
import type { Declarations, Reply } from "../sdk/runtime.ts";
import { schemaErrors, toJson } from "../sdk/validate.ts";
import { ArtifactError, discardNode, mountedInput, type NodeDirs, nodeDirName, prepareNode, resolveDrafts, verifyRefs } from "./artifacts.ts";
import type { CommandRunner } from "./commands.ts";
import { baseIdentity, bwrapAvailable, LAYOUT, resolveBins, SandboxError, sandboxDigest, Sandboxes } from "./confine.ts";
import { canonical } from "./render.ts";
import { checkContainment, type McpSpawn } from "./tools.ts";
import { bundleWorkflow } from "./bundle.ts";
import { HUMAN, IdleNode, LiveNode, must, OwnedRun, ResumableRun, SteerableNode } from "./capability.ts";
import { type BudgetKind, type CallAgentEffect, Core, type Effect, type Event, type Outcome, type Pin, SEMANTICS, type Snapshot, type Usage } from "./core.ts";
import type { AgentSandbox, Executor, NodeSession, NodeSpec, TranscriptEntry } from "./executor.ts";
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
	/** Runs command calls. Without one, every command call fails as `unrunnable`. */
	readonly commands?: CommandRunner;
	/**
	 * `auto` (default): bwrap sandboxes when bwrap works here; `require`:
	 * refuse without bwrap; `off`: no sandbox preflight and no bwrap (tests
	 * with fake commands; agents' `bash` reports it, MCP servers run unconfined
	 * and the MCP containment preflight is skipped).
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
	#boxes: Sandboxes | null = null;
	/** Per sandbox: its identity (declaration, binaries, mount content), part of command node digests. */
	#sandboxDigests: Record<string, string> = {};
	/** Per node name: the digest of its definition, the first part of its journal key. */
	readonly #nodeDigests = new Map<string, string>();
	/** Occurrences of each (node, input) in this execution of the body. */
	#occurrences = new Map<string, number>();
	#code = "";
	#input: Json = null;
	#seed = 0;
	/** Set when the code changed since the last session: hits so far, until the first new call. */
	#codeChange: { hits: number; reported: boolean } | null = null;
	/** A restarted held node: the body runs again, in a fresh VM, against the journal. */
	#restarting = false;
	/** Aborts a command call in flight (restart, cancel). */
	readonly #commandAborts = new Map<string, AbortController>();
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
	restart(node: LiveNode, note?: string, turns = 0): Refusal | null {
		if (this.#settled) return { type: "not_running" };
		const id = node.node.id;
		const held = this.#core.snapshot().held === id;
		// The old session (or process) and dirs go first: the reissued call creates fresh ones.
		this.#nodes.get(id)?.session.interrupt?.();
		this.#commandAborts.get(id)?.abort();
		this.#closeNode(id);
		discardNode(this.paths.dir, id);
		this.#transcriptLog(id)({ kind: "note", text: `restarted${note === undefined ? "" : `: ${note}`}` });
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
		const refusal = this.#feed({ type: "node_cancelled", node: id, by: node.owned.by })[0];
		if (refusal) return refusal;
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
		this.#sandbox = await this.#newSandbox();
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
		this.#prepareSandboxes(prior.length === 0, inputs);

		let input: Json;
		let seed: number;
		if (prior.length === 0) {
			this.#preflight();
			await this.#containment();
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
			this.#feed({ type: "executor_changed", name: o.executor.id });
			if (o.owner) this.#feed({ type: "claimed", owner: o.owner });
		} else {
			const first = prior[0]!;
			if (first.type !== "started") throw new Error(`log ${this.paths.log} does not begin with a started event`);
			this.#core = Core.refold(prior);
			for (const e of prior) if (e.type === "sent" || e.type === "steered") this.#seen.add(e.message_id);
			seed = o.seed ?? first.pin.seed;
			input = first.input;
			must(ResumableRun.check(this.#core, { workflow_digest: this.#digest, prior_digests: [], models: first.pin.models, seed, inputs, semantics: SEMANTICS }), refused);
			// Changed code is allowed: logged, and the body re-executes against the journal.
			const recorded = this.#core.snapshot().code[0];
			if (recorded !== undefined && recorded !== this.#digest && this.#core.snapshot().status.type !== "finished") {
				this.#feed({ type: "code_changed", from: recorded, to: this.#digest });
				this.#codeChange = { hits: 0, reported: false };
			}
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
	#prepareSandboxes(fresh: boolean, inputs: Readonly<Record<string, string>>): void {
		const o = this.#options;
		const decls = this.#decl.sandboxes;
		const meta = readMeta(this.paths)!;
		try {
			const bins = fresh || !meta.bins
				? resolveBins(this.#decl.core.name, decls, { callTime: o.bins, profile: this.#local.bins, path: o.callerPath ?? process.env.PATH })
				: Object.fromEntries(Object.entries(meta.bins).map(([n, b]) => [n, b.path]));
			const confine = o.confine ?? "auto";
			const can = confine !== "off" && bwrapAvailable();
			if (confine === "require" && !can) throw new Error("bubblewrap is required but cannot create a sandbox here");
			const mounts = Object.fromEntries(Object.entries(this.#mounts).map(([n, m]) => [n, m.dir]));
			const digests = Object.fromEntries(Object.keys(mounts).map((n) => [n, inputs[`mount.${n}`] ?? ""]));
			this.#sandboxDigests = Object.fromEntries(Object.entries(decls).map(([n, d]) => [n, sandboxDigest(d, bins, digests)]));
			this.#boxes = can ? new Sandboxes({ decls, bins, mounts, mountDigests: digests }) : null;
			const versions = this.#boxes ? this.#boxes.prepare((text) => process.stderr.write(`wallis: ${text}\n`)) : {};
			for (const note of this.#boxes?.notes ?? []) process.stderr.write(`wallis: ${note}\n`);
			writeMeta(this.paths, {
				...meta,
				bins: Object.fromEntries(Object.entries(bins).map(([n, path]) => [n, versions[n] === undefined ? { path } : { path, version: versions[n]! }])),
				base: meta.base ?? baseIdentity(),
				confined: this.#boxes !== null,
			});
		} catch (error) {
			if (error instanceof SandboxError) throw new RunRefused(error.refusal);
			throw error;
		}
	}

	/** How an MCP server of this workflow starts: in its overlay sandbox (unconfined only with confine off). */
	#mcpSpawn(): McpSpawn | undefined {
		const boxes = this.#boxes;
		if (!boxes) return undefined;
		return (server, argv, env) => {
			const box = this.#decl.mcpServers[server]?.sandbox;
			if (!box) throw new Error(`MCP server ${server} has no sandbox in the workflow's mcp overlay`);
			const scratch = join(this.paths.dir, "work", `mcp-${nodeDirName(server)}`);
			mkdirSync(scratch, { recursive: true });
			return boxes.spawn(box, argv, { scratch, inputs: null }, { env });
		};
	}

	/** Preflight of every allowlisted MCP tool's annotations: no writes outside unless the overlay allows them. */
	async #containment(): Promise<void> {
		// Confinement off is for tests and development: no MCP servers are started in preflight.
		if ((this.#options.confine ?? "auto") === "off") return;
		const agents = Object.fromEntries(Object.entries(this.#decl.agents).filter(([, a]) => Object.keys(a.mcp).length > 0));
		if (Object.keys(agents).length === 0) return;
		const allow = Object.fromEntries(Object.entries(this.#decl.mcpServers).map(([s, o]) => [s, o.allow_writes]));
		const servers = (this.#decl.mcp as { mcpServers?: Json } | null)?.mcpServers ?? null;
		const bad = await checkContainment(agents, allow, servers, process.env, this.#mcpSpawn());
		if (bad) throw new RunRefused({ type: "tool_writes_outside", ...bad });
	}

	#agentSandbox(name: string | null, dirs: NodeDirs): AgentSandbox {
		if (name === null) return { type: "none" };
		const boxes = this.#boxes;
		if (!boxes) return { type: "unavailable", name, reason: "confinement is off or bubblewrap cannot create a sandbox here" };
		return { type: "bwrap", name, spawn: (argv) => boxes.spawn(name, argv, { scratch: dirs.scratch, inputs: dirs.inputs }) };
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
				return node instanceof IdleNode ? this.answer(node, entry.text, entry.id, entry.turns ?? 0) : node;
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
		const effects = this.#core.step(event);
		this.#noteCodeChange(event, effects);
		for (const effect of effects) {
			if (effect.type === "refuse" && effect.id === null) refusals.push(effect.refusal);
			else this.#handle(effect, event);
		}
		return refusals;
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
	 * The journal key of a request: its node's definition digest, and its
	 * occurrence among calls with the same node and input in this execution
	 * of the body (issue order, which is synchronous and deterministic).
	 */
	#keyed(event: Extract<Event, { type: "requested" }>): Event {
		const r = event.request as { type: string; agent?: string; command?: string; input?: Json };
		const name = r.type === "call" ? `agent:${r.agent}` : `command:${r.command}`;
		let digest = this.#nodeDigests.get(name);
		if (digest === undefined) {
			const definition =
				r.type === "call"
					? { kind: "agent", ...this.#decl.agents[r.agent!], sandbox: this.#decl.agents[r.agent!]?.sandbox ? this.#decl.sandboxes[this.#decl.agents[r.agent!]!.sandbox!] : null }
					: { kind: "command", ...this.#decl.commands[r.command!], env: this.#sandboxDigests[this.#decl.commands[r.command!]?.sandbox ?? ""] ?? null };
			digest = createHash("sha256").update(canonical(JSON.parse(JSON.stringify(definition)) as Json)).digest("hex");
			this.#nodeDigests.set(name, digest);
		}
		const key = `${digest}\n${canonical(r.input ?? null)}`;
		const occurrence = this.#occurrences.get(key) ?? 0;
		this.#occurrences.set(key, occurrence + 1);
		return { ...event, node_digest: digest, occurrence };
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
		const r = request as { type: string; agent?: string; input?: Json; command?: string };
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
	#parseOutput(output: unknown, schema: unknown, scratch: string | null): { ok: true; value: Json } | { ok: false; error: string; missing?: string } {
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
			const mounts = declaration.sandbox === null ? [] : this.#decl.sandboxes[declaration.sandbox]!.mounts;
			workspace = prepareNode(this.paths.dir, id, effect.input, this.#mountDirs(mounts));
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
			turn: effect.turn,
			turnLimit: effect.turn_limit,
			checkpoint: join(workspace.root, "session.json"),
			digest: effect.digest,
			transcript: message === undefined ? effect.transcript : effect.transcript.slice(0, -1),
			outputSchema: declaration.output as unknown as Json,
			workspace,
			sandbox: this.#agentSandbox(declaration.sandbox, workspace),
			exportArtifact: (path, media, name) =>
				resolveDrafts(name === undefined ? { artifact: path, media } : { artifact: path, media, name }, this.paths.dir, workspace.scratch) as unknown as ArtifactRef,
			mcp: this.#mcpFor(declaration),
			mcpSpawn: this.#mcpSpawn(),
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
			.then((s) => s.turn(message, effect.turn_limit))
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
							this.#afterIdle(id, log);
							return;
						}
						if (turn.type === "turn_limit") {
							this.#feed({ type: "turn_limit_reached", ...base, used: turn.used, limit: turn.limit, usage });
							this.#afterIdle(id, log);
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

	/**
	 * A command call: its argv from the command's pure `run` (in the workflow
	 * VM, on the mounted input), the process in its sandbox, then its pure
	 * `parse`; files it names must exist in its scratch dir; the output is
	 * checked against the schema. Every failure is a typed `CommandFailure`.
	 */
	/** A message parked by an interrupt is delivered once the aborted turn has ended. */
	#afterIdle(id: string, log: (entry: TranscriptEntry) => void): void {
		const parked = this.#afterInterrupt.get(id);
		if (parked === undefined) return;
		this.#afterInterrupt.delete(id);
		const owned = this.owned(parked.by);
		const node = owned instanceof OwnedRun ? IdleNode.check(owned, id) : owned;
		const refusal = node instanceof IdleNode ? this.answer(node, parked.text) : node;
		if (refusal) log({ kind: "note", text: `the message after the interrupt was refused: ${JSON.stringify(refusal)}` });
	}

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
			workspace = prepareNode(this.paths.dir, id, effect.input, this.#mountDirs(this.#decl.sandboxes[declaration.sandbox]!.mounts));
		} catch (error) {
			return later(() => failed({ type: "unrunnable", error: errorText(error) }));
		}
		const input = mountedInput(effect.input, LAYOUT.inputs);
		const argv = this.#sandbox!.argv(effect.command, input);
		if (!argv.ok) return later(() => failed({ type: "unrunnable", error: `run: ${argv.error}` }));
		this.#commandAborts.get(id)?.abort();
		const abort = new AbortController();
		this.#commandAborts.set(id, abort);
		const env: Record<string, string> = effect.compute_minutes === null ? {} : { WALLIS_COMPUTE_MINUTES: String(effect.compute_minutes) };
		const spawn = this.#boxes?.spawn(declaration.sandbox, argv.argv, { scratch: workspace.scratch, inputs: workspace.inputs }, { gpu: (declaration.resources.gpu ?? 0) > 0, env }) ?? null;
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
							const parsed = this.#sandbox!.parse(effect.command, { exit: r.exit, stdout: r.stdout, stderr: r.stderr });
							if (!parsed.ok) failed({ type: "output_mismatch", errors: [`parse: ${parsed.error}`] }, r.minutes);
							else {
								const out = this.#parseOutput(parsed.output, declaration.output, workspace.scratch);
								if (out.ok) this.#feed({ type: "command_returned", id, output: out.value, minutes: r.minutes });
								else failed(out.missing === undefined ? { type: "output_mismatch", errors: [out.error] } : { type: "missing_file", name: out.missing }, r.minutes);
							}
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
		for (const id of [...this.#nodes.keys()]) this.#closeNode(id);
		this.#sandbox?.dispose();
		this.#sandbox = null;
		this.#release();
	}
}
