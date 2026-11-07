// The thin host: bundles the workflow, runs its body in the sandbox, steps
// the core with every request and result, executes the core's effects and
// appends checkpointed events to the log. Resume refolds the log, checks
// the pin and replays the body; the core answers completed requests from
// its journal.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Value from "typebox/value";
import type { Json } from "../sdk/index.ts";
import { bundleWorkflow } from "./bundle.ts";
import { Core, type Effect, type Event, type Outcome, type Pin } from "./core.ts";
import { type Executor, ExecutorError, type ScriptRunner } from "./executor.ts";
import { EventLog } from "./log.ts";
import { type Profile, resolveModels } from "./models.ts";
import { Sandbox } from "./sandbox.ts";

export interface RunOptions {
	/** Path to workflow.ts. */
	readonly workflow: string;
	/** Path to the JSONL event log. An existing, non-empty log is resumed. */
	readonly log: string;
	readonly executor: Executor;
	readonly scripts?: ScriptRunner;
	readonly input?: Json;
	readonly seed?: number;
	/** Root for the pin's input files. Defaults to the working directory. */
	readonly root?: string;
	/** Call-time alias remaps. */
	readonly models?: Readonly<Record<string, string>>;
	readonly profile?: Profile;
}

export interface RunResult {
	readonly outcome: Outcome;
	/** Canonical JSON of the final run state (see `Core.snapshot`). */
	readonly snapshot: string;
	readonly resumed: boolean;
}

/** The core refused the run as a whole (pin mismatch, path divergence, invalid declarations). */
export class RunRefused extends Error {
	override readonly name = "RunRefused";
}

const NO_USAGE = { usd: 0, tokens: 0, turns: 0 };

function digestFile(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export async function runWorkflow(options: RunOptions): Promise<RunResult> {
	const bundle = await bundleWorkflow(options.workflow);
	const requests: Event[] = [];
	const sandbox = await Sandbox.create(bundle.code, {
		send: (json) => requests.push(JSON.parse(json) as Event),
		done: (json) => requests.push({ type: "body_finished", output: JSON.parse(json) as Json }),
		fail: (error) => requests.push({ type: "body_failed", error }),
	});
	try {
		return await drive(options, bundle.digest, sandbox, requests);
	} finally {
		sandbox.dispose();
	}
}

function drive(options: RunOptions, workflowDigest: string, sandbox: Sandbox, requests: Event[]): Promise<RunResult> {
	const decl = sandbox.declare();
	const root = options.root ?? process.cwd();
	const pin: Pin = {
		workflow_digest: workflowDigest,
		models: resolveModels(decl.core.name, decl.models, { callTime: options.models, profile: options.profile }),
		seed: options.seed ?? 0,
		inputs: Object.fromEntries(decl.pin.files.map((f) => [f, digestFile(resolve(root, f))])),
	};
	const log = new EventLog(options.log);
	const core = new Core();
	const prior = log.read();
	const deliveries: [string, Json][] = [];

	return new Promise<RunResult>((done, fail) => {
		let settled = false;
		const finish = (outcome: Outcome) => {
			settled = true;
			done({ outcome, snapshot: core.snapshot(), resumed: prior.length > 0 });
		};
		const refuse = (reason: string) => {
			settled = true;
			fail(new RunRefused(reason));
		};

		const feed = (event: Event) => {
			for (const effect of core.step(event)) handle(effect, event);
		};
		const pump = () => {
			while (!settled && (deliveries.length > 0 || requests.length > 0)) {
				const delivery = deliveries.shift();
				if (delivery) sandbox.deliver(delivery[0], delivery[1]);
				else feed(requests.shift()!);
			}
		};
		const later = (event: Event) => {
			if (settled) return;
			try {
				feed(event);
				pump();
			} catch (error) {
				settled = true;
				fail(error);
			}
		};

		const handle = (effect: Effect, event: Event) => {
			switch (effect.type) {
				case "checkpoint":
					log.append(event);
					return;
				case "call_agent": {
					const declaration = decl.agents[effect.agent]!;
					const call = {
						id: effect.id,
						agent: effect.agent,
						declaration,
						model: effect.model,
						view: effect.view,
						omitted: effect.omitted,
						input: effect.input,
						maxTurns: effect.max_turns,
						digest: effect.digest,
					};
					options.executor.call(call).then(
						(result) => {
							const usage = result.usage ?? NO_USAGE;
							if (!Value.Check(declaration.output as never, result.output)) {
								later({ type: "agent_failed", id: effect.id, error: `output of ${effect.agent} does not match its schema`, usage });
							} else {
								later({ type: "agent_returned", id: effect.id, output: result.output, emits: [...(result.emits ?? [])], usage });
							}
						},
						(error: unknown) =>
							later({
								type: "agent_failed",
								id: effect.id,
								error: error instanceof Error ? error.message : String(error),
								usage: error instanceof ExecutorError && error.usage ? error.usage : NO_USAGE,
							}),
					);
					return;
				}
				case "run_script": {
					if (!options.scripts) {
						later({ type: "script_failed", id: effect.id, error: "no script runner", minutes: 0 });
						return;
					}
					options.scripts
						.run({ id: effect.id, script: effect.script, args: effect.args, computeMinutes: effect.compute_minutes, digest: effect.digest })
						.then(
							(result) => later({ type: "script_returned", id: effect.id, output: result.output, minutes: result.minutes }),
							(error: unknown) =>
								later({ type: "script_failed", id: effect.id, error: error instanceof Error ? error.message : String(error), minutes: 0 }),
						);
					return;
				}
				case "deliver":
					deliveries.push([effect.id, { type: "deliver", value: effect.value }]);
					return;
				case "fail":
					deliveries.push([effect.id, { type: "fail", error: effect.error }]);
					return;
				case "refuse":
					if (effect.id === null) refuse(effect.reason);
					else deliveries.push([effect.id, { type: "refuse", reason: effect.reason }]);
					return;
				case "finish":
					finish(effect.outcome);
					return;
			}
		};

		try {
			let input: Json;
			if (prior.length > 0) {
				const first = prior[0]!;
				if (first.type !== "started") throw new RunRefused(`log ${options.log} does not begin with a started event`);
				for (const event of prior) core.step(event);
				input = first.input;
				feed({ type: "resumed", pin });
			} else {
				input = options.input ?? null;
				feed({ type: "started", workflow: decl.core as unknown as Json, pin, input });
			}
			if (!settled) {
				sandbox.start(input, pin.seed);
				pump();
			}
		} catch (error) {
			settled = true;
			fail(error);
		}
	});
}
