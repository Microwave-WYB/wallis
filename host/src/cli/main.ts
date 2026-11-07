#!/usr/bin/env node
// The wallis CLI. Runs live under `.wallis/runs/` of the project (the
// working directory, or --root).
//
//   wallis run <workflow> [--input json] [--seed n] [--model a=m]... [--executor module] [--detach]
//   wallis resume <run> [--model a=m]... [--budget kind=limit]... [--executor module] [--detach]
//   wallis send <run> <node> <text>
//   wallis cancel <run>
//   wallis status <run> [--json]
//   wallis wait <run> [--timeout seconds] [--json]
//   wallis pending [--json]
//   wallis fork <run> --at <events|node> [--model a=m]... [--detach]
//   wallis serve [--executor module]

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Json } from "../sdk/index.ts";
import type { BudgetKind } from "../host/core.ts";
import { EventLog } from "../host/log.ts";
import { attention, describe, forkRun, inspectRun, pending, waitForAttention } from "../host/query.ts";
import { loadExecutor, resolveRun, resolveWorkflow, Runs } from "../host/runs.ts";
import { RunRefused, startSession, type SessionOptions } from "../host/session.ts";
import { acquireLock, appendInbox, lockHolder, newMessageId, newRunId, readMeta, runPaths, runsDir, writeMeta } from "../host/store.ts";

const self = fileURLToPath(import.meta.url);

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		root: { type: "string" },
		input: { type: "string" },
		seed: { type: "string" },
		model: { type: "string", multiple: true },
		budget: { type: "string", multiple: true },
		executor: { type: "string" },
		detach: { type: "boolean" },
		json: { type: "boolean" },
		timeout: { type: "string" },
		at: { type: "string" },
	},
});

const root = resolve(values.root ?? process.cwd());
const [command, ...args] = positionals;

function pairs(list: string[] | undefined): Record<string, string> {
	return Object.fromEntries(
		(list ?? []).map((p) => {
			const i = p.indexOf("=");
			if (i <= 0) throw new Error(`expected name=value, got ${p}`);
			return [p.slice(0, i), p.slice(i + 1)];
		}),
	);
}

function budgets(list: string[] | undefined): Partial<Record<BudgetKind, number>> {
	const kinds: Record<string, BudgetKind> = { usd: "usd", tokens: "tokens", turns: "turns", computeMinutes: "compute_minutes", compute_minutes: "compute_minutes" };
	return Object.fromEntries(
		Object.entries(pairs(list)).map(([k, v]) => {
			const kind = kinds[k];
			if (!kind) throw new Error(`unknown budget ${k}`);
			return [kind, Number(v)];
		}),
	);
}

function out(text: string): void {
	if (text) process.stdout.write(`${text}\n`);
}

function report(dir: string): void {
	const view = inspectRun(dir);
	if (values.json) return out(JSON.stringify({ run_id: view.runId, status: view.run.status, stopped: view.stopped, nodes: view.run.nodes, spent: view.run.spent }));
	const items = attention(view);
	out(items.length > 0 ? describe(items) : `Run ${view.runId}: ${view.run.status?.type}${view.stopped ? ", stopped" : ""}.`);
}

/** Starts a detached driver for the run; the lock names it before it starts. */
function detach(dir: string, extra: string[] = []): void {
	const child = spawn(process.execPath, [self, "drive", dir, "--root", root, ...extra], { detached: true, stdio: "ignore" });
	acquireLock(runPaths(dir), child.pid);
	child.unref();
}

async function drive(dir: string, options: Partial<SessionOptions>): Promise<void> {
	const paths = runPaths(dir);
	const meta = readMeta(paths);
	const module = values.executor ? resolve(values.executor) : (meta?.executor ?? process.env.WALLIS_EXECUTOR ?? null);
	if (!module) throw new Error("no executor: pass --executor <module> (the pi executor is not built yet)");
	if (meta && module !== meta.executor) writeMeta(paths, { ...meta, executor: module });
	const kit = await loadExecutor(module);
	const start = meta?.start ?? {};
	const fresh = new EventLog(paths.log).read().length === 0;
	const session = await startSession({
		dir,
		executor: kit.executor,
		scripts: kit.scripts,
		executorModule: module,
		root: meta?.root ?? root,
		...(fresh ? start : {}),
		...options,
	});
	await session.result;
}

/**
 * Hands an inbox entry to the run's driver, starting a detached one if none
 * is alive, and returns once the driver has taken it (a send is logged, or
 * the inbox entry is marked done), so a following `wait` sees its effect.
 */
async function deliver(dir: string, entry: Parameters<typeof appendInbox>[1]): Promise<void> {
	const paths = runPaths(dir);
	appendInbox(paths, entry);
	const taken = () =>
		(existsSync(`${paths.inbox}.done`) && readFileSync(`${paths.inbox}.done`, "utf8").split("\n").includes(entry.id)) ||
		new EventLog(paths.log).read().some((e) => e.type === "sent" && e.message_id === entry.id);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline && !taken()) {
		if (lockHolder(paths) === null) detach(dir);
		await new Promise((r) => setTimeout(r, 100));
	}
}

async function main(): Promise<number> {
	switch (command) {
		case "run": {
			const workflow = resolveWorkflow(root, args[0] ?? "");
			const name = workflow.split("/").at(-2) ?? "run";
			const dir = join(runsDir(root), newRunId(name));
			const start = {
				input: values.input ? (JSON.parse(values.input) as Json) : null,
				seed: values.seed ? Number(values.seed) : undefined,
				models: pairs(values.model),
			};
			const executor = values.executor ? resolve(values.executor) : (process.env.WALLIS_EXECUTOR ?? null);
			writeMeta(runPaths(dir), { run_id: runPaths(dir).id, workflow, root, executor, created: new Date().toISOString(), start });
			if (values.detach) {
				detach(dir);
				out(`Started run ${runPaths(dir).id}.\nTo be notified when it needs attention, run in the background: npx wallis wait ${runPaths(dir).id}`);
				return 0;
			}
			await drive(dir, {});
			report(dir);
			return 0;
		}
		case "resume":
		case "drive": {
			const dir = command === "drive" ? resolve(args[0]!) : resolveRun(root, args[0] ?? "");
			const options = { models: pairs(values.model), budget: budgets(values.budget) };
			if (values.detach) {
				detach(dir, [...(values.model ?? []).flatMap((m) => ["--model", m]), ...(values.budget ?? []).flatMap((b) => ["--budget", b])]);
				out(`Resuming run ${runPaths(dir).id}. To be notified: npx wallis wait ${runPaths(dir).id}`);
				return 0;
			}
			await drive(dir, options);
			if (command === "resume") report(dir);
			return 0;
		}
		case "send": {
			const [run, node, ...words] = args;
			const dir = resolveRun(root, run ?? "");
			const view = inspectRun(dir);
			const target = view.run.nodes.find((n) => n.id === node);
			if (!target || target.status.type !== "node_idle") {
				out(`Refused: ${JSON.stringify({ type: "not_idle", node })}`);
				return 1;
			}
			await deliver(dir, { id: newMessageId(), type: "send", node: node!, text: words.join(" ") });
			out(`Sent to ${node} of run ${view.runId}. To be notified: npx wallis wait ${view.runId}`);
			return 0;
		}
		case "cancel": {
			const dir = resolveRun(root, args[0] ?? "");
			if (inspectRun(dir).run.status?.type === "finished") {
				report(dir);
				return 0;
			}
			await deliver(dir, { id: newMessageId(), type: "cancel" });
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline && inspectRun(dir).run.status?.type !== "finished") await new Promise((r) => setTimeout(r, 100));
			report(dir);
			return 0;
		}
		case "status":
			report(resolveRun(root, args[0] ?? ""));
			return 0;
		case "wait": {
			const dir = resolveRun(root, args[0] ?? "");
			const items = await waitForAttention(dir, values.timeout ? { timeoutMs: Number(values.timeout) * 1000 } : {});
			if (!items) {
				out(`Run ${runPaths(dir).id} is still running.`);
				return 2;
			}
			out(values.json ? JSON.stringify(items) : describe(items));
			return 0;
		}
		case "pending": {
			const items = pending(root);
			if (items.length > 0) out(values.json ? JSON.stringify(items) : describe(items));
			return 0;
		}
		case "fork": {
			const source = resolveRun(root, args[0] ?? "");
			if (!values.at) throw new Error("--at <events|node> is required");
			const at = /^\d+$/.test(values.at) ? Number(values.at) : values.at;
			const meta = readMeta(runPaths(source));
			const name = meta ? (meta.workflow.split("/").at(-2) ?? "run") : "run";
			const target = forkRun(source, join(runsDir(root), newRunId(name)), at);
			out(`Forked ${runPaths(source).id} at ${values.at} into ${target.id}.`);
			if (values.detach) {
				detach(target.dir, (values.model ?? []).flatMap((m) => ["--model", m]));
				return 0;
			}
			await drive(target.dir, { models: pairs(values.model) });
			report(target.dir);
			return 0;
		}
		case "serve": {
			const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
			const { createMcpServer } = await import("../host/mcp.ts");
			const module = values.executor ? resolve(values.executor) : (process.env.WALLIS_EXECUTOR ?? null);
			if (!module) throw new Error("no executor: pass --executor <module> (the pi executor is not built yet)");
			const server = createMcpServer(new Runs(root, await loadExecutor(module), module));
			await server.connect(new StdioServerTransport());
			return new Promise<number>(() => {});
		}
		default:
			process.stderr.write(`usage: wallis run|resume|send|cancel|status|wait|pending|fork|serve ...\n`);
			return 64;
	}
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		if (error instanceof RunRefused) out(`Refused: ${JSON.stringify(error.refusal)}`);
		else process.stderr.write(`wallis: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);

