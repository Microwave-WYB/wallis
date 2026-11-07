// One builder arm: a coding agent in a bwrap sandbox, working in phases.
// Each phase is a fresh pi session (saved per turn); /work/NOTES.md
// carries memory between phases. Status is written to
// work/<arm>/status.json after every turn and tool call; the returned
// object is what the console exposes (status, steer, stop, the raw agent).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { runAgent } from "./lib/agent.ts";
import { builderTools } from "./lib/builder-tools.ts";
import { step } from "./lib/steps.ts";
import type { AgentHandle, AgentResult } from "./lib/tool.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const prompt = (name: string) => readFileSync(`${here}prompts/${name}.md`, "utf8");

export const DEEPSEEK = "fireworks/accounts/fireworks/models/deepseek-v4p1-flash";
const NODE = `${homedir()}/.local/share/mise/installs/node/26.13.0`;
const GLEAM = `${homedir()}/.local/share/mise/installs/gleam/1.19.2`;
const SIDERIUS = "/tmp/siderius-src/SIDERIUS";
const SKILL = `${here}../skill`;

const PhaseResult = Type.Object({
	status: Type.Union([Type.Literal("continue"), Type.Literal("done")]),
	summary: Type.String({ description: "What this phase did, and what is next." }),
	test_command: Type.Optional(Type.String({ description: "When done: the end-to-end test command." })),
});

export interface ArmOptions {
	readonly phases?: number;
	readonly turnsPerPhase?: number;
	readonly model?: string;
	/** Override the arm's dir (tests). */
	readonly workDir?: string;
}

export interface Status {
	arm: string;
	state: "running" | "done" | "failed" | "stopped";
	phase: number;
	turn: number;
	maxTurns: number;
	lastTool: string;
	lastText: string;
	usage: { input: number; output: number; cacheRead: number };
	updatedAt: string;
	error?: string;
}

/** Starts arm "a" (custom pi program) or "b" (wallis workflow) in the background. */
export function builderArm(arm: "a" | "b", options: ArmOptions = {}) {
	// pi's own credential store wins over the environment (a stale key in ~/.env once shadowed it).
	const authFile = `${homedir()}/.pi/agent/auth.json`;
	if (existsSync(authFile)) {
		const auth = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, { key?: string }>;
		if (auth.fireworks?.key) process.env.FIREWORKS_API_KEY = auth.fireworks.key; // never logged
	}
	const dir = options.workDir ?? `${here}work/${arm}`;
	mkdirSync(`${dir}/.home`, { recursive: true });
	const phases = options.phases ?? 8;
	const maxTurns = options.turnsPerPhase ?? 100;
	const status: Status = {
		arm, state: "running", phase: 0, turn: 0, maxTurns, lastTool: "", lastText: "",
		usage: { input: 0, output: 0, cacheRead: 0 }, updatedAt: new Date().toISOString(),
	};
	const save = () => {
		status.updatedAt = new Date().toISOString();
		writeFileSync(`${dir}/status.json`, JSON.stringify(status, null, 2));
	};
	const logLine = (line: string) => {
		writeFileSync(`${dir}/log.txt`, `${new Date().toISOString()} ${line}\n`, { flag: "a" });
	};

	const ro: Record<string, string> = { [SIDERIUS]: "/mnt/siderius", [NODE]: "/opt/node" };
	if (arm === "a") ro[SKILL] = "/mnt/skill";
	else ro[GLEAM] = "/opt/gleam";
	const tools = builderTools({ ro, work: dir, path: ["/opt/node/bin", "/opt/gleam"] }, (line) => {
		status.lastTool = line;
		logLine(`[p${status.phase} t${status.turn}] ${line}`);
		save();
	});

	let handle: AgentHandle | null = null;
	let stopped = false;
	const system = `${prompt("common")}\n\n${prompt(arm)}`;

	const done = (async () => {
		for (let p = 1; p <= phases && !stopped; p++) {
			status.phase = p;
			status.turn = 0;
			save();
			logLine(`phase ${p} starts`);
			const result = await step(`${dir}/phases/${p}.json`, async () => {
				let r: AgentResult<{ status: "continue" | "done"; summary: string; test_command?: string }> = await runAgent(
					{
						model: options.model ?? DEEPSEEK,
						system,
						tools,
						output: PhaseResult,
						maxTurns,
						thinking: "high",
						session: `${dir}/sessions/phase-${p}.json`,
						log: logLine,
						attach: (h) => ((handle = h), () => (handle = null)),
						onTurn: ({ turn, text, usage }) => {
							status.turn = turn;
							if (text) status.lastText = text.slice(0, 500);
							status.usage.input += usage.input;
							status.usage.output += usage.output;
							status.usage.cacheRead += usage.cacheRead;
							save();
						},
					},
					{ phase: p, of: phases, reminder: "Start by reading /work/NOTES.md if it exists." },
				);
				// A question mid-phase: there is no one to ask; tell it to decide and go on, once.
				if (r.type === "question") {
					logLine(`asked: ${r.message.slice(0, 300)}`);
					r = await runAgent(
						{ model: options.model ?? DEEPSEEK, system, tools, output: PhaseResult, maxTurns, thinking: "high", session: `${dir}/sessions/phase-${p}.json`, log: logLine, answer: "There is no one to ask. Decide yourself, note the decision in /work/NOTES.md, and continue." },
						null,
					);
				}
				if (r.type === "submitted") return r.value;
				if (r.type === "failed" && r.kind === "turn_limit") return { status: "continue" as const, summary: "turn quota reached" };
				throw new Error(r.type === "failed" ? `${r.kind}: ${r.error}` : `asked again: ${r.message}`);
			}).catch((e: unknown) => {
				status.state = stopped ? "stopped" : "failed";
				status.error = e instanceof Error ? e.message : String(e);
				save();
				throw e;
			});
			logLine(`phase ${p} ends: ${result.status}: ${result.summary.slice(0, 300)}`);
			if (result.status === "done") {
				status.state = "done";
				save();
				return result;
			}
		}
		status.state = stopped ? "stopped" : "failed";
		status.error ??= stopped ? "stopped by the owner" : `no done after ${phases} phases`;
		save();
		return null;
	})();
	done.catch(() => {});

	return {
		status,
		done,
		get handle() {
			return handle;
		},
		/** Delivered to the running agent after its current turn. */
		steer(text: string) {
			if (!handle) return "no agent running right now";
			handle.steer(text);
			logLine(`steered: ${text.slice(0, 300)}`);
			return "queued";
		},
		stop() {
			stopped = true;
			handle?.abort();
			return "stopping";
		},
		tail(n = 20) {
			return existsSync(`${dir}/log.txt`) ? readFileSync(`${dir}/log.txt`, "utf8").trimEnd().split("\n").slice(-n).join("\n") : "";
		},
	};
}
