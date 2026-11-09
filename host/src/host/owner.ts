// Who owns a run: the harness that started it, or the human.
//
// - A run started over MCP is owned by the harness that runs `wallis serve`:
//   its nearest harness ancestor (the server is often started through a
//   wrapper: `npx`, `sh -c`, `mise exec`), else its parent.
// - A CLI caller is its nearest harness ancestor, or the human if it has none.
// So an orchestrator's MCP calls and its shell's `npx wallis wait` resolve
// to the same harness process.
// - The human at a terminal with no harness ancestor owns everything.
// Identities are `human` or `harness:<name>:<pid>:<start time>`; the start
// time (from /proc) makes a reused pid a different owner. `WALLIS_OWNER`
// overrides the caller's identity (tests, scripted callers).

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export type Owner = string;

export const HUMAN: Owner = "human";

const DEFAULT_HARNESSES = ["claude", "codex", "cursor-agent", "cursor", "gemini", "pi", "opencode", "aider", "goose", "amp", "paseo"];

function harnesses(): string[] {
	return process.env.WALLIS_HARNESSES ? process.env.WALLIS_HARNESSES.split(",").map((s) => s.trim()) : DEFAULT_HARNESSES;
}

interface Proc {
	readonly pid: number;
	readonly ppid: number;
	readonly name: string;
	readonly start: string;
}

function proc(pid: number): Proc | null {
	const file = `/proc/${pid}/stat`;
	if (!existsSync(file)) return null;
	try {
		const stat = readFileSync(file, "utf8");
		const close = stat.lastIndexOf(")");
		const fields = stat.slice(close + 2).split(" ");
		let name = stat.slice(stat.indexOf("(") + 1, close);
		// Interpreted harnesses (node, python) show their script in argv.
		const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		const named = argv.slice(0, 3).map((a) => basename(a).replace(/\.(m?js|ts|py)$/, "")).find((a) => harnesses().includes(a));
		if (named) name = named;
		return { pid, ppid: Number(fields[1]), name, start: fields[19] ?? "0" };
	} catch {
		return null;
	}
}

function identity(p: Proc): Owner {
	return `harness:${p.name}:${p.pid}:${p.start}`;
}

function nearestHarness(): Proc | null {
	const names = harnesses();
	let pid = process.ppid;
	for (let depth = 0; depth < 64 && pid > 1; depth++) {
		const p = proc(pid);
		if (!p) break;
		if (names.includes(p.name)) return p;
		pid = p.ppid;
	}
	return null;
}

/** The caller: `WALLIS_OWNER`, else the nearest harness ancestor, else the human. */
export function callerIdentity(): Owner {
	if (process.env.WALLIS_OWNER) return process.env.WALLIS_OWNER;
	const p = nearestHarness();
	return p ? identity(p) : HUMAN;
}

/** The harness that runs `wallis serve`: its nearest harness ancestor, else its parent, whatever it is called. */
export function serverOwner(): Owner {
	if (process.env.WALLIS_OWNER) return process.env.WALLIS_OWNER;
	const p = nearestHarness() ?? proc(process.ppid);
	return p ? identity(p) : HUMAN;
}

/** Whether the owner still exists: a harness whose pid and start time still match. */
export function ownerAlive(owner: Owner | null): boolean {
	if (owner === null) return false;
	const m = /^harness:[^:]*:(\d+):(\d+)$/.exec(owner);
	if (!m) return true;
	const p = proc(Number(m[1]));
	return p !== null && p.start === m[2];
}

/** The human owns everything; anyone else controls only its own runs. */
export function mayControl(caller: Owner, owner: Owner | null): boolean {
	return caller === HUMAN || (owner !== null && owner === caller);
}

export class NotOwner extends Error {
	override readonly name = "NotOwner";
	constructor(runId: string, owner: Owner | null, caller: Owner) {
		super(
			owner === null
				? `run ${runId} has no owner; claim it first: npx wallis claim ${runId}`
				: `run ${runId} is owned by ${owner}, not by ${caller}. Read-only commands work on it; to take it over: npx wallis claim ${runId}`,
		);
	}
}
