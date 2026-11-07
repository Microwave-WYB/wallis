// Starting and addressing runs in a project: workflows by name, executors
// from modules, and the sessions this process drives.

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Json, Refusal } from "../sdk/index.ts";
import type { BudgetKind } from "./core.ts";
import type { Executor, ScriptRunner } from "./executor.ts";
import { inspectRun, type RunView } from "./query.ts";
import { type Session, type SessionOptions, startSession } from "./session.ts";
import { mayControl, NotOwner, type Owner, serverOwner } from "./owner.ts";
import { newRunId, runPaths, runsDir } from "./store.ts";

export interface ExecutorKit {
	readonly executor: Executor;
	readonly scripts?: ScriptRunner;
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
}

export interface ResumeRun {
	readonly models?: Readonly<Record<string, string>>;
	readonly budget?: Readonly<Partial<Record<BudgetKind, number>>>;
	readonly sends?: readonly { readonly node: string; readonly text: string }[];
	readonly cancel?: boolean;
}

/** The runs this process drives, one session at a time per run. */
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
	control(runId: string): void {
		const view = this.view(runId);
		if (!mayControl(this.owner, view.owner)) throw new NotOwner(runId, view.owner, this.owner);
	}

	#track(session: Session): Session {
		this.#live.set(session.paths.id, session);
		session.result.finally(() => {
			if (this.#live.get(session.paths.id) === session) this.#live.delete(session.paths.id);
		}).catch(() => {});
		return session;
	}

	#options(dir: string): Pick<SessionOptions, "dir" | "executor" | "scripts" | "executorModule" | "root"> {
		return { dir, executor: this.#kit.executor, scripts: this.#kit.scripts, executorModule: this.#executorModule, root: this.root };
	}

	async start(request: StartRun): Promise<Session> {
		const workflow = resolveWorkflow(this.root, request.workflow);
		const name = workflow.split("/").at(-2) ?? "run";
		const dir = join(runsDir(this.root), newRunId(name));
		return this.#track(
			await startSession({ ...this.#options(dir), workflow, input: request.input ?? null, seed: request.seed, models: request.models, owner: this.owner }),
		);
	}

	async resume(runId: string, request: ResumeRun = {}): Promise<Session> {
		this.control(runId);
		const live = this.#live.get(runId);
		if (live && !live.settled) {
			for (const s of request.sends ?? []) {
				const refusal = live.send(s.node, s.text);
				if (refusal) throw new SendRefused(refusal);
			}
			if (request.cancel) live.cancel();
			return live;
		}
		return this.#track(await startSession({ ...this.#options(resolveRunDir(this.root, runId)), ...request }));
	}

	view(runId: string): RunView {
		return inspectRun(resolveRunDir(this.root, runId));
	}

	live(runId: string): Session | undefined {
		return this.#live.get(runId);
	}
}

function resolveRunDir(root: string, runId: string): string {
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
