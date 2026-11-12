// Driving one run in this process: a new run or a resume, in the
// foreground (the caller's process) or in a detached child (runner.ts).
// The process takes the run's lock, opens its journal, builds the session
// and runs the body; the caller's messages arrive through the run's inbox.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentRunner } from "./agents.ts";
import { loadExecutor, readConfig } from "./config.ts";
import { type Json, SEMANTICS } from "./host/core.ts";
import { Journal } from "./host/journal.ts";
import { acquireLock, type RunPaths } from "./host/runs.ts";
import { Store } from "./host/store.ts";
import { DEF, isNode, type WorkflowDef, workflowDef } from "./nodes.ts";
import { Plans } from "./plans.ts";
import { type Outcome, RunSession } from "./runtime.ts";
import { ToolCaller } from "./toolcalls.ts";

/** Set in a detached run's process: run() there is a module calling it at its top level. */
export const RUNNER_PROCESS: unique symbol = Symbol.for("wallis.runner-process");

/** Refuses to start a run inside a run's process (a workflow module that starts runs when imported). */
export function notInRunner(): void {
	if ((globalThis as { [RUNNER_PROCESS]?: true })[RUNNER_PROCESS]) {
		throw new Error("run() was called while a run's process imported its workflow module: keep caller code out of the workflow's module, or guard it with `if (import.meta.main)`");
	}
}

/** What a detached run process is asked to do (`<run>/start.json`). */
export interface StartRequest {
	readonly module: string;
	readonly digest: string;
	readonly name: string | null;
	readonly input: Json;
	readonly resume?: { readonly retry: readonly string[]; readonly turns: number | null };
	readonly onExit?: string;
}

/** The run's name for its id: the workflow's const name, else its module's dir or file name. */
export function workflowName(def: WorkflowDef): string {
	if (def.site.name && def.site.name !== "default") return def.site.name;
	const file = basename(def.site.file).replace(/\.[cm]?[jt]s$/, "");
	return file === "workflow" || file === "index" ? basename(dirname(def.site.file)) : file;
}

/** Finds a workflow in its module: by definition digest, else (the code changed) by its const name. */
export async function importWorkflow(module: string, digest: string, name: string | null): Promise<WorkflowDef> {
	const mod = (await import(pathToFileURL(module).href)) as Record<string, unknown>;
	const wfs = Object.entries(mod).filter(([, v]) => isNode(v, "workflow"));
	const byDigest = wfs.find(([, v]) => workflowDef(v as { kind: "workflow" }).digest === digest);
	if (byDigest) return workflowDef(byDigest[1] as { kind: "workflow" });
	const byName = wfs.find(([k, v]) => k === name || workflowDef(v as { kind: "workflow" }).site.name === name);
	if (byName) return workflowDef(byName[1] as { kind: "workflow" });
	throw new Error(`${module} has no workflow ${name ?? digest}`);
}

export interface Launched {
	readonly session: RunSession;
	readonly result: Promise<Outcome>;
}

/**
 * Runs (or resumes) a run here. `input` is the journal form (refs without
 * paths, host files already ingested). Resolves when the body ends.
 */
export async function launch(options: { root: string; paths: RunPaths; def: WorkflowDef; input: Json; resume?: { retry: readonly string[]; turns: number | null }; signals?: boolean }): Promise<Launched> {
	const { root, paths, def } = options;
	mkdirSync(paths.dir, { recursive: true });
	const release = acquireLock(paths);
	const journal = Journal.open(paths.log);
	const store = new Store(root);
	const config = readConfig(root);
	const kit = await loadExecutor(config);
	const plans = new Plans([join(root, ".wallis")]);
	const facts = () => journal.core.facts();
	const tools = new ToolCaller({
		store,
		work: paths.work,
		plans,
		recorded: (key) => {
			const v = facts()[`bundle:${key}`];
			return typeof v === "string" ? v : undefined;
		},
		record: (key, bundle) => {
			if (facts()[`bundle:${key}`] !== bundle) session.step({ type: "noted", key: `bundle:${key}`, value: bundle });
		},
	});
	const agents = new AgentRunner({ models: kit.models, getApiKey: kit.getApiKey, aliases: config.models, tools, retryDelaysMs: config.retryDelaysMs });
	const session: RunSession = new RunSession({ journal, store, paths, root, workflow: def, plans, tools, agents });
	const resuming = journal.core.snapshot().status !== "not_started";
	let input = options.input;
	if (!resuming) {
		session.step({ type: "started", workflow: { name: def.label, digest: def.digest }, input, semantics: SEMANTICS });
		session.step({ type: "noted", key: "workflow", value: { label: def.label, file: def.site.file, name: def.site.name, digest: def.digest } });
		session.step({ type: "noted", key: "created", value: new Date().toISOString() });
		session.step({ type: "noted", key: "root", value: root });
	} else {
		const snap = journal.core.snapshot();
		if ("input" in snap) input = snap.input;
		session.step({ type: "resumed", digest: def.digest, semantics: SEMANTICS });
		for (const call of options.resume?.retry ?? []) session.step({ type: "retried", call, turns: options.resume?.turns ?? 0 });
		if (facts().ended_at !== undefined && !session.ended) session.step({ type: "noted", key: "ended_at", value: null });
	}
	// Also what keeps a run's process alive while its body only waits for messages.
	const timer = setInterval(() => session.applyInbox(), 250);
	const stop = () => {
		session.abort();
		release();
		process.exit(143);
	};
	if (options.signals !== false) {
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
	}
	if (!session.ended) session.start(input);
	session.applyInbox();
	const result = session.result.finally(() => {
		clearInterval(timer);
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		release();
	});
	return { session, result };
}

/** Records what a detached run process should do, for it to read. */
export function writeStart(paths: RunPaths, request: StartRequest): void {
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(join(paths.dir, "start.json"), `${JSON.stringify(request, null, 1)}\n`);
}

export function readStart(paths: RunPaths): StartRequest {
	return JSON.parse(readFileSync(join(paths.dir, "start.json"), "utf8")) as StartRequest;
}

export function processLog(paths: RunPaths, line: string): void {
	if (!existsSync(paths.dir)) return;
	appendFileSync(join(paths.dir, "process.log"), `${new Date().toISOString()} ${line}\n`);
}

export { DEF };
