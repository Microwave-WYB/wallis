// Starting and addressing runs in a project: workflows by name, executors
// from modules, and the sessions this process drives.

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Json, Refusal } from "../sdk/index.ts";
import { toJson } from "../sdk/validate.ts";
import type { BudgetKind } from "./core.ts";
import { type CommandRunner, ProcessCommands } from "./commands.ts";
import type { Executor } from "./executor.ts";
import { IdleNode, LiveNode, must, type NodeId, OwnedRun, type RunId, SteerableNode, SubmittableNode } from "./capability.ts";
import { NotOwner, type Owner, serverOwner } from "./owner.ts";
import { loadProfile } from "./profile.ts";
import { applyControl, deliveryOf, inspectRun, type RunView } from "./query.ts";
import { type Session, type SessionOptions, startSession } from "./session.ts";
import { MachineSlots } from "./slots.ts";
import { appendInbox, type InboxEntry, newMessageId, newRunId, readMeta, refusedEntry, runPaths, runsDir } from "./store.ts";

export interface ExecutorKit {
	readonly executor: Executor;
	readonly commands?: CommandRunner;
	/** Test and development kits only: `off` runs MCP servers and commands unconfined (see `SessionOptions.confine`). */
	readonly confine?: "auto" | "require" | "off";
}

/** Loads an executor module: its default export returns `{ executor, scripts? }`. */
export async function loadExecutor(module: string): Promise<ExecutorKit> {
	const mod = (await import(pathToFileURL(resolve(module)).href)) as { default: () => ExecutorKit | Promise<ExecutorKit> };
	return mod.default();
}

/** Workflows of a project: every `.agents/workflows/<name>/workflow.ts`. */
export function workflowsIn(root: string): Record<string, string> {
	const dir = join(resolve(root), ".agents", "workflows");
	if (!existsSync(dir)) return {};
	return Object.fromEntries(
		readdirSync(dir)
			.sort()
			.filter((name) => existsSync(join(dir, name, "workflow.ts")))
			.map((name) => [name, join(dir, name, "workflow.ts")]),
	);
}

export function resolveWorkflow(root: string, nameOrPath: string): string {
	const named = workflowsIn(root)[nameOrPath];
	if (named) return named;
	if (existsSync(nameOrPath)) return resolve(nameOrPath);
	throw new Error(`no workflow ${nameOrPath} under ${join(resolve(root), ".agents", "workflows")}`);
}

/** A run id under the project's runs directory, or a path to a run directory. */
export function resolveRun(root: string, run: string): string {
	const named = join(runsDir(root), run);
	if (existsSync(join(named, "log.jsonl")) || existsSync(join(named, "meta.json"))) return named;
	if (existsSync(join(run, "log.jsonl"))) return resolve(run);
	throw new Error(`no run ${run} under ${runsDir(root)}`);
}

export interface StartRun {
	readonly workflow: string;
	readonly input?: Json;
	readonly seed?: number;
	readonly models?: Readonly<Record<string, string>>;
	readonly volumes?: Readonly<Record<string, string>>;
	readonly bins?: Readonly<Record<string, string>>;
}

export interface ResumeRun {
	readonly models?: Readonly<Record<string, string>>;
	readonly budget?: Readonly<Partial<Record<BudgetKind, number>>>;
	readonly sends?: readonly { readonly node: string; readonly text: string; readonly turns?: number }[];
	readonly cancel?: boolean;
	readonly unpause?: boolean;
}


/**
 * The runs this process drives, one session at a time per run. Ids from
 * outside are parsed (`RunId`, `NodeId`) and every intervention goes
 * through its capability check.
 */
export class Runs {
	readonly root: string;
	readonly #kit: ExecutorKit;
	readonly #executorModule: string | null;
	readonly #live = new Map<string, Session>();
	/** Who this process acts for: the harness that runs `wallis serve`. */
	readonly owner: Owner;

	constructor(root: string, kit: ExecutorKit, executorModule: string | null = null, owner: Owner = serverOwner()) {
		this.root = resolve(root);
		this.#kit = kit;
		this.#executorModule = executorModule;
		this.owner = owner;
	}

	/** Changing or answering a run needs ownership; reading does not. */
	control(runId: RunId): OwnedRun {
		const view = this.view(runId);
		const owned = OwnedRun.check(view.run, this.owner);
		if (!(owned instanceof OwnedRun)) throw new NotOwner(runId, view.owner, this.owner);
		return owned;
	}

	#track(session: Session): Session {
		this.#live.set(session.paths.id, session);
		session.result.finally(() => {
			if (this.#live.get(session.paths.id) === session) this.#live.delete(session.paths.id);
		}).catch(() => {});
		return session;
	}

	/** Without a command runner from the executor module: sandboxed processes with machine-wide slots, as the CLI does. */
	#options(dir: string): Pick<SessionOptions, "dir" | "executor" | "commands" | "executorModule" | "root" | "by" | "confine"> {
		const commands = this.#kit.commands ?? new ProcessCommands({ slots: new MachineSlots(loadProfile(this.root).slots) });
		return { dir, executor: this.#kit.executor, commands, executorModule: this.#executorModule, root: this.root, by: this.owner, ...(this.#kit.confine ? { confine: this.#kit.confine } : {}) };
	}

	async start(request: StartRun): Promise<Session> {
		const workflow = resolveWorkflow(this.root, request.workflow);
		const name = workflow.split("/").at(-2) ?? "run";
		const dir = join(runsDir(this.root), newRunId(name));
		return this.#track(
			await startSession({
				...this.#options(dir),
				workflow,
				input: request.input ?? null,
				seed: request.seed,
				models: request.models,
				volumes: request.volumes,
				bins: request.bins,
				callerPath: process.env.PATH,
				owner: this.owner,
			}),
		);
	}

	/** The live session of a run, resuming it if no session drives it. */
	async #session(runId: RunId, request: ResumeRun = {}): Promise<Session> {
		const live = this.#live.get(runId);
		if (live && !live.settled) return live;
		const dir = resolveRunDir(this.root, runId);
		const meta = readMeta(runPaths(dir));
		if (!meta) throw new Error(`run ${runId} has no meta.json`);
		return this.#track(await startSession({ ...this.#options(dir), ...request }));
	}

	async resume(runId: RunId, request: ResumeRun = {}): Promise<Session> {
		this.control(runId);
		const live = this.#live.get(runId);
		if (live && !live.settled) {
			const owned = must(live.owned(this.owner), refused);
			for (const s of request.sends ?? []) {
				const refusal = live.answer(must(IdleNode.check(owned, s.node), refused), s.text, undefined, s.turns ?? 0);
				if (refusal) throw new SendRefused(refusal);
			}
			if (request.cancel) live.cancel(owned);
			if (request.unpause) live.unpause(owned);
			return live;
		}
		return this.#session(runId, request);
	}

	/**
	 * A message to an agent node: delivered if it is idle, queued as a steer
	 * after its current turn if it is running. Returns how it was delivered.
	 */
	async send(runId: RunId, node: NodeId, text: string, turns = 0): Promise<string> {
		this.control(runId);
		const id = newMessageId();
		const live = this.#live.get(runId);
		if (live && !live.settled) {
			const sent = live.send(must(live.owned(this.owner), refused), node, text, id, turns);
			if ("refusal" in sent) throw new SendRefused(sent.refusal);
		} else await this.#viaInbox(runId, turns > 0 ? { id, type: "send", node, text, by: this.owner, turns } : { id, type: "send", node, text, by: this.owner });
		return deliveryOf(resolveRunDir(this.root, runId), id) ?? `sent to ${node}`;
	}

	/** Aborts a running node's current turn: it goes Idle(interrupted), progress kept. */
	interrupt(runId: RunId, node: NodeId): void {
		const live = this.#running(runId, node);
		const refusal = live.interrupt(must(SteerableNode.check(must(live.owned(this.owner), refused), node), refused));
		if (refusal) throw new SendRefused(refusal);
	}

	/** The orchestrator's result for an orchestrator node, or its decision on an approval; checked against its schema. */
	async submit(runId: RunId, node: NodeId, value: unknown): Promise<void> {
		const owned = this.control(runId);
		must(SubmittableNode.check(owned, node), refused);
		const live = this.#live.get(runId);
		if (live && !live.settled) {
			const refusal = live.submit(must(SubmittableNode.check(must(live.owned(this.owner), refused), node), refused), value);
			if (refusal) throw new SendRefused(refusal);
		} else {
			const json = toJson(value);
			if (!json.ok) throw new SendRefused({ type: "invalid_answer", node, errors: json.errors });
			await this.#viaInbox(runId, { id: newMessageId(), type: "submit", node, value: json.value, by: this.owner });
		}
	}

	#running(runId: RunId, node: NodeId): Session {
		this.control(runId);
		const live = this.#live.get(runId);
		if (!live || live.settled) throw new SendRefused({ type: "node_not_running", node });
		return live;
	}

	/** Discards a node's progress and reissues its call with the note. */
	async restart(runId: RunId, node: NodeId, note?: string, turns = 0): Promise<void> {
		const owned = this.control(runId);
		must(LiveNode.check(owned, node), refused);
		const live = this.#live.get(runId);
		const entry: InboxEntry = { id: newMessageId(), type: "restart", node, by: this.owner, ...(note === undefined ? {} : { note }), ...(turns > 0 ? { turns } : {}) };
		if (live && !live.settled) {
			const refusal = live.restart(must(LiveNode.check(must(live.owned(this.owner), refused), node), refused), note, turns);
			if (refusal) throw new SendRefused(refusal);
		} else await this.#viaInbox(runId, entry);
	}

	async cancelNode(runId: RunId, node: NodeId): Promise<void> {
		const owned = this.control(runId);
		must(LiveNode.check(owned, node), refused);
		const live = this.#live.get(runId);
		if (live && !live.settled) {
			const refusal = live.cancelNode(must(LiveNode.check(must(live.owned(this.owner), refused), node), refused));
			if (refusal) throw new SendRefused(refusal);
		} else await this.#viaInbox(runId, { id: newMessageId(), type: "cancel_node", node, by: this.owner });
	}

	/** A run no session drives takes the intervention from its inbox when a session boots; a refusal is reported back. */
	async #viaInbox(runId: RunId, entry: InboxEntry): Promise<void> {
		const paths = runPaths(resolveRunDir(this.root, runId));
		appendInbox(paths, entry);
		await this.#session(runId);
		const refusal = refusedEntry(paths, entry.id);
		if (refusal) throw new SendRefused(refusal);
	}

	async pause(runId: RunId): Promise<void> {
		const owned = this.control(runId);
		const live = this.#live.get(runId);
		const refusal =
			live && !live.settled ? live.pause(must(live.owned(this.owner), refused)) : applyControl(resolveRunDir(this.root, runId), { type: "pause_requested", by: owned.by });
		if (refusal) throw new SendRefused(refusal);
	}

	async unpause(runId: RunId): Promise<void> {
		await this.resume(runId, { unpause: true });
	}

	async cancel(runId: RunId): Promise<void> {
		await this.resume(runId, { cancel: true });
	}

	view(runId: RunId): RunView {
		return inspectRun(resolveRunDir(this.root, runId));
	}

	live(runId: RunId): Session | undefined {
		return this.#live.get(runId);
	}
}

const refused = (refusal: Refusal) => new SendRefused(refusal);

function resolveRunDir(root: string, runId: RunId): string {
	return runPaths(join(runsDir(root), runId)).dir;
}

export class SendRefused extends Error {
	override readonly name = "SendRefused";
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(`refused: ${JSON.stringify(refusal)}`);
		this.refusal = refusal;
	}
}
