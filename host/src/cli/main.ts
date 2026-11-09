#!/usr/bin/env node
// The wallis CLI. Runs live under `.wallis/runs/` of the project (the
// working directory, or --root).
//
//   wallis run <workflow> [--input json] [--seed n] [--model a=m]... [--mount name=dir]... [--executor module] [--detach]
//   wallis resume <run> [--model a=m]... [--budget kind=limit]... [--executor module] [--detach]
//   wallis describe <workflow>               its input, agents and the questions it may ask (JSON)
//   wallis doc                               how to write and orchestrate workflows
//   wallis send <run> <node> <text> [--turns n]   idle: delivered; running: queued as a steer
//   wallis submit <run> <node> '<json>'      complete an orchestrator node (checked against its schema)
//   wallis restart <run> <node> [note]       discard the node's progress, reissue with the note
//   wallis cancel <run>
//   wallis status <run> [--json]
//   wallis wait <run> [--timeout seconds] [--json]
//   wallis pending [--json]
//   wallis claim <run>
//   wallis ls | tree <run> | log <run> [--follow] [--since n] | show <run> [<node>]
//   wallis interrupt <run> <node> | pause <run> | cancel <run> [--node <node>]
//   wallis wait [<run>] waits on one run, or on all of the caller's own runs
//   wallis fork <run> [--model a=m]... [--detach]   (copies the journal; unchanged calls hit)
//   wallis export <run> <artifact> <dir>
//   wallis serve [--executor module]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Json } from "../sdk/index.ts";
import type { BudgetKind } from "../host/core.ts";
import { EventLog } from "../host/log.ts";
import {
	applyControl,
	attention,
	claimable,
	describe,
	exportArtifact,
	forkRun,
	inspectRun,
	latestObservations,
	listRunViews,
	nodeTranscript,
	pending,
	renderTree,
	runLine,
	runLog,
	waitForAttention,
	waitForOwn,
} from "../host/query.ts";
import { LiveNode, must, OwnedRun, parseNodeId, parseRunId, SteerableNode, SubmittableNode } from "../host/capability.ts";
import { describeWorkflow } from "../host/describe.ts";
import { deliveryOf } from "../host/query.ts";
import type { Refusal } from "../sdk/index.ts";
import { callerIdentity, mayControl, NotOwner } from "../host/owner.ts";
import { loadExecutor, resolveRun, resolveWorkflow, Runs } from "../host/runs.ts";
import { loadProfile } from "../host/profile.ts";
import { ProcessCommands } from "../host/commands.ts";
import { CONTINUE } from "../host/query.ts";
import { limitProviders, MachineSlots, systemdAvailable } from "../host/slots.ts";
import { RunRefused, startSession, type SessionOptions } from "../host/session.ts";
import { acquireLock, appendInbox, RunLocked, lockHolder, newMessageId, newRunId, readMeta, refusedEntry, runPaths, runsDir, writeLaunch } from "../host/store.ts";
import { toJson } from "../sdk/validate.ts";

const self = fileURLToPath(import.meta.url);
/** pi, with pi-ai's built-in providers. */
const DEFAULT_EXECUTOR = fileURLToPath(new URL("../executors/pi.ts", import.meta.url));

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		root: { type: "string" },
		input: { type: "string" },
		seed: { type: "string" },
		model: { type: "string", multiple: true },
		mount: { type: "string", multiple: true },
		bin: { type: "string", multiple: true },
		turns: { type: "string" },
		budget: { type: "string", multiple: true },
		executor: { type: "string" },
		detach: { type: "boolean" },
		json: { type: "boolean" },
		timeout: { type: "string" },
		since: { type: "string" },
		limit: { type: "string" },
		follow: { type: "boolean" },
		node: { type: "string" },
		unpause: { type: "boolean" },
	},
});

const root = resolve(values.root ?? process.cwd());
const caller = callerIdentity();

/** Commands that change or answer a run work only on the caller's own runs. */
function control(dir: string): OwnedRun {
	const view = inspectRun(dir);
	const owned = OwnedRun.check(view.run, caller);
	if (!(owned instanceof OwnedRun)) throw new NotOwner(view.runId, view.owner, caller);
	return owned;
}


const refused = (refusal: Refusal) => new RunRefused(refusal);

/** The run dir and node id named on the command line, parsed. */
function target(run: string | undefined, node: string | undefined): { dir: string; node: string } {
	return { dir: resolveRun(root, parseRunId(run)), node: parseNodeId(node) };
}
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
	const kinds: Record<string, BudgetKind> = { turns: "turns", computeMinutes: "compute_minutes", compute_minutes: "compute_minutes" };
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
	const observed = latestObservations(view);
	if (values.json) {
		return out(JSON.stringify({ run_id: view.runId, status: view.run.status, stopped: view.stopped, nodes: view.run.nodes, observed, spent: view.run.spent, attention: attention(view) }));
	}
	const items = attention(view);
	out(items.length > 0 ? describe(items) : `Run ${view.runId}: ${view.run.status?.type}${view.stopped ? ", stopped" : ""}.`);
	const labels = Object.entries(observed);
	if (labels.length > 0) out(`Observed: ${labels.map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 200)}`).join("; ")}`);
}

/** `WALLIS_HOST`: `systemd`, `plain`, or (default) systemd when `systemd-run --user` works. */
function hostMode(): "systemd" | "plain" {
	const mode = process.env.WALLIS_HOST;
	if (mode === "plain" || mode === "systemd") return mode;
	return systemdAvailable() ? "systemd" : "plain";
}

/** The environment a detached host needs: wallis settings, paths, provider credentials. */
function hostEnv(): string[] {
	return Object.entries(process.env)
		.filter(([k, v]) => v !== undefined && /^(WALLIS_.*|PATH|HOME|LANG|XDG_.*|.*_API_KEY|.*_TOKEN|.*_BASE_URL)$/.test(k))
		.map(([k, v]) => `--setenv=${k}=${v}`);
}

/**
 * Starts a detached host for the run: a systemd user unit
 * (`wallis-run-<id>`, restarted on failure) when available, else a plain
 * detached process whose lock is written before it starts. Hosts exit when
 * the run is idle or finished.
 */
function detach(dir: string, extra: string[] = []): void {
	const paths = runPaths(dir);
	const argv = [self, "drive", dir, "--root", root, ...extra];
	const logged = new EventLog(paths.log).read().length;
	if (hostMode() === "systemd") {
		const r = spawnSync(
			"systemd-run",
			["--user", "--quiet", "--collect", `--unit=wallis-run-${paths.id}`, "-p", "Restart=on-failure", `--working-directory=${root}`, ...hostEnv(), "--", process.execPath, ...argv],
			{ stdio: "ignore" },
		);
		if (r.status === 0) {
			// The unit takes the lock itself; wait for it so a following `wait` does not see a stopped run.
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline && lockHolder(paths) === null && new EventLog(paths.log).read().length === logged) spawnSync("sleep", ["0.05"]);
			return;
		}
	}
	const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore" });
	acquireLock(paths, child.pid);
	child.unref();
}

async function drive(dir: string, options: Partial<SessionOptions>): Promise<void> {
	const paths = runPaths(dir);
	const meta = readMeta(paths);
	const module = values.executor ? resolve(values.executor) : (meta?.executor ?? process.env.WALLIS_EXECUTOR ?? DEFAULT_EXECUTOR);
	const kit = await loadExecutor(module);
	const local = loadProfile(meta?.root ?? root);
	const start = meta?.start ?? {};
	const fresh = new EventLog(paths.log).read().length === 0;
	const workflow = meta?.workflow;
	const session = await startSession({
		dir,
		executor: limitProviders(kit.executor, local.providers ?? {}),
		commands: kit.commands ?? new ProcessCommands({ slots: new MachineSlots(local.slots) }),
		executorModule: module,
		root: meta?.root ?? root,
		by: caller,
		...(kit.confine ? { confine: kit.confine } : {}),
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
		refusedEntry(paths, entry.id) !== null ||
		new EventLog(paths.log).read().some((e) => (e.type === "sent" || e.type === "steered") && e.message_id === entry.id);
	const deadline = Date.now() + 15_000;
	let started = 0;
	while (Date.now() < deadline && !taken()) {
		// One host per handoff; another only if that one has come and gone without taking it.
		if (lockHolder(paths) === null && Date.now() - started > 3000) {
			detach(dir);
			started = Date.now();
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	// Not taken and not refused: say so (a non-zero exit), never return as if it were delivered.
	if (!taken()) throw new Error(`no host of run ${paths.id} took the entry within 15 s; it stays in the inbox`);
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
				mounts: pairs(values.mount),
				bins: pairs(values.bin),
				// Binaries resolve against the CALLER's PATH, not the detached host's.
				callerPath: process.env.PATH,
				owner: caller,
			};
			const executor = values.executor ? resolve(values.executor) : (process.env.WALLIS_EXECUTOR ?? null);
			writeLaunch(runPaths(dir), { workflow, root, executor, created: new Date().toISOString(), start });
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
			if (command === "resume") control(dir);
			// `resume` also lifts a pause.
			const options = { models: pairs(values.model), budget: budgets(values.budget), unpause: command === "resume" || values.unpause === true };
			if (values.detach) {
				detach(dir, [...(values.model ?? []).flatMap((m) => ["--model", m]), ...(values.budget ?? []).flatMap((b) => ["--budget", b]), "--unpause"]);
				out(`Resuming run ${runPaths(dir).id}. To be notified: npx wallis wait ${runPaths(dir).id}`);
				return 0;
			}
			await drive(dir, options);
			if (command === "resume") report(dir);
			return 0;
		}
		case "describe": {
			out(JSON.stringify(await describeWorkflow(resolveWorkflow(root, args[0] ?? ""), root), null, 2));
			return 0;
		}
		case "doc": {
			out(readFileSync(fileURLToPath(new URL("./doc.md", import.meta.url)), "utf8").trimEnd());
			return 0;
		}
		case "send": {
			const [run, id, ...words] = args;
			const { dir, node } = target(run, id);
			control(dir);
			const turns = values.turns ? Number(values.turns) : 0;
			const text = words.join(" ") || (turns > 0 ? CONTINUE : "");
			const entry = { id: newMessageId(), type: "send" as const, node, text, by: caller, ...(turns > 0 ? { turns } : {}) };
			// The driver decides how it is delivered (idle: now; running: as a steer) and checks again.
			await deliver(dir, entry);
			const refusal = refusedEntry(runPaths(dir), entry.id);
			if (refusal) throw new RunRefused(refusal);
			out(`Sent: ${deliveryOf(dir, entry.id) ?? `to ${node}`}. To be notified: npx wallis wait ${runPaths(dir).id}`);
			return 0;
		}
		case "submit": {
			const [run, id, value] = args;
			const { dir, node } = target(run, id);
			must(SubmittableNode.check(control(dir), node), refused);
			let parsed: unknown;
			try {
				parsed = JSON.parse(value ?? "");
			} catch {
				throw new RunRefused({ type: "invalid_answer", node, errors: ["the value is not JSON"] });
			}
			const json = toJson(parsed);
			if (!json.ok) throw new RunRefused({ type: "invalid_answer", node, errors: json.errors });
			const entry = { id: newMessageId(), type: "submit" as const, node, value: json.value, by: caller };
			await deliver(dir, entry);
			// Checked against the node's answer schema by the driver; a mismatch leaves it pending.
			const refusal = refusedEntry(runPaths(dir), entry.id);
			if (refusal) throw new RunRefused(refusal);
			out(`Submitted to ${node} of run ${runPaths(dir).id}. To be notified: npx wallis wait ${runPaths(dir).id}`);
			return 0;
		}
		case "interrupt": {
			const [run, id] = args;
			const { dir, node } = target(run, id);
			must(SteerableNode.check(control(dir), node), refused);
			if (lockHolder(runPaths(dir)) === null) throw new RunRefused({ type: "node_not_running", node });
			await deliver(dir, { id: newMessageId(), type: "interrupt", node, by: caller });
			out(`Interrupted ${node} of run ${runPaths(dir).id}: it waits, progress kept. Redirect it with: npx wallis send ${runPaths(dir).id} '${node}' "<message>"`);
			return 0;
		}
		case "restart": {
			const [run, id, ...words] = args;
			const { dir, node } = target(run, id);
			must(LiveNode.check(control(dir), node), refused);
			const turns = values.turns ? Number(values.turns) : 0;
			// `--model alias=...` rebinds first (a logged alias_rebound), so the restarted call uses it.
			if ((values.model ?? []).length > 0) {
				if (lockHolder(runPaths(dir)) !== null) throw new Error("rebind with resume --model while no host drives the run, then restart");
				for (const [alias, to] of Object.entries(pairs(values.model))) {
					const from = inspectRun(dir).run.models[alias];
					if (from === undefined) throw new RunRefused({ type: "unknown_alias", alias });
					const refusal = applyControl(dir, { type: "alias_rebound", alias, from, to });
					if (refusal) throw new RunRefused(refusal);
				}
			}
			const entry = { id: newMessageId(), type: "restart" as const, node, by: caller, ...(words.length > 0 ? { note: words.join(" ") } : {}), ...(turns > 0 ? { turns } : {}) };
			await deliver(dir, entry);
			out(`Restarted ${node} of run ${runPaths(dir).id}; the tools it uses reach the outside again. To be notified: npx wallis wait ${runPaths(dir).id}`);
			return 0;
		}
		case "cancel": {
			const dir = resolveRun(root, parseRunId(args[0]));
			const owned = control(dir);
			if (values.node) {
				// One node: an agent failure for the body to handle.
				const node = parseNodeId(values.node);
				must(LiveNode.check(owned, node), refused);
				// Through the driver (one is started if none runs): the body goes on with the typed failure.
				const entry = { id: newMessageId(), type: "cancel_node" as const, node, by: caller };
				await deliver(dir, entry);
				const refusal = refusedEntry(runPaths(dir), entry.id);
				if (refusal) throw new RunRefused(refusal);
				out(`Cancelled node ${node} of run ${runPaths(dir).id}.`);
				return 0;
			}
			if (inspectRun(dir).run.status?.type === "finished") {
				report(dir);
				return 0;
			}
			await deliver(dir, { id: newMessageId(), type: "cancel", by: caller });
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline && inspectRun(dir).run.status?.type !== "finished") await new Promise((r) => setTimeout(r, 100));
			report(dir);
			return 0;
		}
		case "status":
			report(resolveRun(root, args[0] ?? ""));
			return 0;
		case "wait": {
			const timeout = values.timeout ? { timeoutMs: Number(values.timeout) * 1000 } : {};
			let items;
			if (args[0] === undefined) {
				// No run: wait on the caller's own runs.
				items = await waitForOwn(root, caller, timeout);
				if (!items) {
					out("Your runs are still running.");
					return 2;
				}
			} else {
				const dir = resolveRun(root, args[0]);
				control(dir);
				items = await waitForAttention(dir, timeout);
				if (!items) {
					out(`Run ${runPaths(dir).id} is still running.`);
					return 2;
				}
			}
			out(values.json ? JSON.stringify(items) : describe(items));
			return 0;
		}
		case "pending": {
			const items = pending(root, caller);
			const orphans = claimable(root).filter((v) => !mayControl(caller, v.owner));
			if (values.json) {
				if (items.length > 0 || orphans.length > 0) out(JSON.stringify({ pending: items, claimable: orphans.map((v) => v.runId) }));
				return 0;
			}
			if (items.length > 0) out(describe(items));
			if (orphans.length > 0) {
				out(`${orphans.length} run(s) have no live owner and can be claimed: ${orphans.map((v) => `npx wallis claim ${v.runId}`).join("; ")}`);
			}
			return 0;
		}
		case "ls": {
			const views = listRunViews(root);
			if (values.json) out(JSON.stringify(views.map((v) => ({ run_id: v.runId, workflow: v.workflow, status: v.run.status, stopped: v.stopped, owner: v.owner }))));
			else out(views.map(runLine).join("\n"));
			return 0;
		}
		case "tree":
			out(renderTree(inspectRun(resolveRun(root, args[0] ?? ""))));
			return 0;
		case "log": {
			const dir = resolveRun(root, args[0] ?? "");
			let since = values.since ? Number(values.since) : 0;
			for (;;) {
				const page = runLog(dir, since, values.limit ? Number(values.limit) : 200);
				for (const e of page.items) out(`${e.seq}\t${e.event}`);
				since = page.next;
				if (!values.follow) return 0;
				if (page.next >= page.total) {
					const view = inspectRun(dir);
					if (view.run.status?.type === "finished" || view.stopped) return 0;
					await new Promise((r) => setTimeout(r, 300));
				}
			}
		}
		case "show": {
			const [run, node] = args;
			const dir = resolveRun(root, parseRunId(run));
			if (node === undefined) {
				// The run's observations, in order.
				for (const o of inspectRun(dir).run.observations) out(`${o.at}\t${o.label}\t${JSON.stringify(o.value)}`);
				return 0;
			}
			const page = nodeTranscript(dir, parseNodeId(node), values.since ? Number(values.since) : 0, values.limit ? Number(values.limit) : 200);
			for (const e of page.items) out(`${e.seq}\t${e.entry}`);
			return 0;
		}
		case "pause": {
			const dir = resolveRun(root, args[0] ?? "");
			control(dir);
			if (lockHolder(runPaths(dir)) !== null) await deliver(dir, { id: newMessageId(), type: "pause", by: caller });
			else {
				const refusal = applyControl(dir, { type: "pause_requested", by: caller });
				if (refusal) throw new RunRefused(refusal);
			}
			out(`Paused run ${runPaths(dir).id}: no new calls until npx wallis resume ${runPaths(dir).id}.`);
			return 0;
		}
		case "claim": {
			const dir = resolveRun(root, args[0] ?? "");
			const paths = runPaths(dir);
			if (lockHolder(paths) !== null) await deliver(dir, { id: newMessageId(), type: "claim", owner: caller });
			else {
				const refusal = applyControl(dir, { type: "claimed", owner: caller });
				if (refusal) throw new RunRefused(refusal);
			}
			out(`Run ${paths.id} is now owned by ${caller}.`);
			return 0;
		}
		case "fork": {
			// A fork copies the whole journal (a cache): positions do not matter.
			const source = resolveRun(root, parseRunId(args[0]));
			control(source);
			const meta = readMeta(runPaths(source));
			const name = meta ? (meta.workflow.split("/").at(-2) ?? "run") : "run";
			const target = forkRun(source, join(runsDir(root), newRunId(name)));
			applyControl(target.dir, { type: "claimed", owner: caller });
			out(`Forked ${runPaths(source).id} into ${target.id}.`);
			if (values.detach) {
				detach(target.dir, (values.model ?? []).flatMap((m) => ["--model", m]));
				return 0;
			}
			await drive(target.dir, { models: pairs(values.model) });
			report(target.dir);
			return 0;
		}
		case "export": {
			const [run, artifact, target] = args;
			if (!artifact || !target) throw new Error("usage: wallis export <run> <artifact digest or name> <dir>");
			out(`Exported ${exportArtifact(resolveRun(root, run ?? ""), artifact, resolve(target))}`);
			return 0;
		}
		case "serve": {
			const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
			const { createMcpServer } = await import("../host/mcp.ts");
			const module = values.executor ? resolve(values.executor) : (process.env.WALLIS_EXECUTOR ?? DEFAULT_EXECUTOR);
			const kit = await loadExecutor(module);
			const local = loadProfile(root);
			const server = await createMcpServer(new Runs(root, { ...kit, executor: limitProviders(kit.executor, local.providers ?? {}) }, module));
			await server.connect(new StdioServerTransport());
			return new Promise<number>(() => {});
		}
		default:
			process.stderr.write(`usage: wallis run|resume|send|submit|interrupt|restart|cancel|pause|claim|status|wait|pending|describe|doc|ls|tree|log|show|fork|export|serve ...\n`);
			return 64;
	}
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		// A host that finds its run already driven has nothing to do.
		if (error instanceof RunLocked && command === "drive") process.exit(0);
		if (error instanceof RunRefused) out(`Refused: ${JSON.stringify(error.refusal)}`);
		else if (error instanceof NotOwner) process.stderr.write(`wallis: ${error.message}\n`);
		else process.stderr.write(`wallis: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);

