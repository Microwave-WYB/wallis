// `runAgent` on pi (pi-agent-core + pi-ai 1.5.0): the only file that
// imports an agent SDK.
//
// - pi-agent-core's `Agent`, not the coding agent: no built-in tools, no
//   AGENTS.md / CLAUDE.md, no extensions or skills. It sees `system`, its
//   input and the tools you pass.
// - The result comes back through `submit_result`, whose parameters are the
//   TypeBox output; a mismatch goes back to the model as a tool error.
// - Every request ends with "[Turn k of N]" on the newest message.
// - Transient provider errors retry with backoff; others fail at once.
// - `session`: the conversation is saved after every turn; a later call
//   with the same file continues it (after a crash, or with an `answer`).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";
import type { AgentResult, AgentSpec, Tool, Usage } from "./tool.ts";

/** pi-ai's model registry: `builtinModels()` by default; tests set a faux one. */
export interface Models {
	getModel(provider: string, id: string): unknown;
	streamSimple: (...args: never[]) => unknown;
}

let registry: Models | null = null;

/** Sets the model registry (e.g. pi-ai's faux provider in tests). */
export function setModels(models: Models): void {
	registry = models;
}

async function models(): Promise<Models> {
	if (!registry) registry = (await import("@earendil-works/pi-ai/providers/all")).builtinModels() as unknown as Models;
	return registry;
}

/** Rate limits, overload, 5xx, timeouts, the network: retry. Auth, billing, unknown model: do not. */
export function transient(message: string): boolean {
	if (/\b(401|402|403|404|412)\b|billing|suspended|invalid api key|not found/i.test(message)) return false;
	return /\b(408|429|5\d\d)\b|overloaded|rate.?limit|timed? ?out|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|fetch failed/i.test(message);
}

/** A neutral tool as a pi AgentTool. */
function piTool(t: Tool): AgentTool {
	return {
		name: t.name,
		label: t.name,
		description: t.description,
		parameters: t.parameters as object,
		execute: async (_id, params, signal) => {
			const r = await t.execute(params as never, signal);
			return { content: [{ type: "text", text: r.text }], details: undefined, isError: r.isError === true };
		},
	};
}

/** `submit_result`: validated against the schema (pi also checks the arguments first); errors go back to the model. */
function submitTool<O extends TSchema>(output: O, done: (value: Static<O>) => void): AgentTool {
	return {
		name: "submit_result",
		label: "submit_result",
		description: "Submit your final result. If it does not match the schema you get the errors and may resubmit.",
		parameters: output as object,
		execute: async (_id, params) => {
			if (!Value.Check(output, params)) {
				const errors = [...Value.Errors(output, params)].map((e) => `${e.instancePath || "/"} ${e.message}`);
				return { content: [{ type: "text", text: `Invalid result:\n${errors.join("\n")}` }], details: undefined, isError: true };
			}
			done(params as Static<O>);
			return { content: [{ type: "text", text: "submitted" }], details: undefined, terminate: true };
		},
	};
}

/** Appends "[Turn k of N]" to the newest user or tool-result message (never the system prompt). */
function quota(messages: AgentMessage[], turn: number, limit: number): AgentMessage[] {
	const last = messages.at(-1) as { role: string; content: unknown } | undefined;
	const note = `\n\n[Turn ${turn} of ${limit}]`;
	const stale = /\n\n\[Turn \d+ of \d+\]$/;
	if (last?.role === "user" && typeof last.content === "string") last.content = last.content.replace(stale, "") + note;
	else if (last && (last.role === "user" || last.role === "toolResult") && Array.isArray(last.content)) {
		const parts = last.content as { type: string; text?: string }[];
		const tail = parts.at(-1);
		if (tail?.type === "text" && tail.text !== undefined) tail.text = tail.text.replace(stale, "") + note;
		else parts.push({ type: "text", text: note.trim() });
	}
	return messages;
}

const textOf = (m: AgentMessage | undefined) =>
	m?.role === "assistant" ? m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim() : "";

export async function runAgent<O extends TSchema>(spec: AgentSpec<O>, input: unknown): Promise<AgentResult<Static<O>>> {
	let cleanup: (() => void) | undefined;
	try {
		return await run(spec, input, (c) => (cleanup = c));
	} finally {
		cleanup?.();
	}
}

async function run<O extends TSchema>(spec: AgentSpec<O>, input: unknown, onDetach: (c: () => void) => void): Promise<AgentResult<Static<O>>> {
	const registry = await models();
	const [provider, ...rest] = spec.model.split("/");
	const model = registry.getModel(provider!, rest.join("/"));
	if (!model) return { type: "failed", kind: "provider", error: `unknown model ${spec.model}`, turns: 0 };
	const limit = spec.maxTurns ?? 12;
	const log = spec.log ?? (() => {});
	const saved = spec.session && existsSync(spec.session) ? (JSON.parse(readFileSync(spec.session, "utf8")) as { messages: AgentMessage[]; turns: number }) : null;
	let turns = saved?.turns ?? 0;
	let result: { value: Static<O> } | null = null;

	const agent = new Agent({
		initialState: {
			systemPrompt: spec.system,
			model: model as never,
			thinkingLevel: spec.thinking ?? "off",
			tools: [...(spec.tools ?? []).map(piTool), submitTool(spec.output, (value) => (result = { value }))],
			messages: saved?.messages ?? [],
		},
		streamFn: registry.streamSimple.bind(registry) as never,
		toolExecution: "sequential",
		transformContext: async (messages) => quota(messages, turns + 1, limit),
	});
	const save = () => {
		if (!spec.session) return;
		mkdirSync(dirname(spec.session), { recursive: true });
		writeFileSync(`${spec.session}.tmp`, JSON.stringify({ messages: agent.state.messages, turns }));
		renameSync(`${spec.session}.tmp`, spec.session);
	};
	agent.subscribe((event) => {
		if (event.type !== "turn_end") return;
		const last = agent.state.messages.at(-1);
		// A failed or aborted reply is not a turn, and not progress.
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) return;
		turns++;
		save();
		if (spec.onTurn) {
			const u = (last as { usage?: { input?: number; output?: number; cacheRead?: number } } | undefined)?.usage;
			const usage: Usage = { input: u?.input ?? 0, output: u?.output ?? 0, cacheRead: u?.cacheRead ?? 0 };
			spec.onTurn({ turn: turns, text: textOf(last), usage });
		}
		if (turns >= limit && !result) agent.abort();
	});

	const detach = spec.attach?.({
		steer: (text) => agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as never),
		abort: () => agent.abort(),
		raw: agent,
	});
	if (detach) onDetach(detach);

	// A fresh call starts from the input; a saved one continues (with the answer, if any).
	const restored = saved !== null && saved.messages.length > 0;
	if (restored) log(`resumed after turn ${saved.turns}`);
	let start = !restored
		? () => agent.prompt(`Input:\n${JSON.stringify(input, null, 2)}`)
		: spec.answer !== undefined
			? () => agent.prompt(spec.answer!)
			: () => agent.continue();
	const delays = spec.retries ?? [5_000, 30_000, 120_000];
	for (let attempt = 0; ; attempt++) {
		let thrown: string | null = null;
		try {
			await start();
			await agent.waitForIdle();
		} catch (e) {
			// Our own abort at the turn limit is handled below; anything else is an error to classify.
			if (turns < limit) thrown = e instanceof Error ? e.message : String(e);
		}
		const last = agent.state.messages.at(-1);
		const error = thrown ?? (last?.role === "assistant" && last.stopReason === "error" ? (last.errorMessage ?? "provider error") : null);
		// Our abort at the turn limit can leave an error reply behind: the limit wins.
		if (!error || (turns >= limit && !result)) break;
		if (!transient(error) || attempt >= delays.length) return { type: "failed", kind: "provider", error, turns };
		log(`transient error (${error}); retry ${attempt + 1} in ${delays[attempt]} ms`);
		await new Promise((r) => setTimeout(r, delays[attempt]));
		if (agent.state.messages.at(-1)?.role === "assistant") agent.state.messages = agent.state.messages.slice(0, -1);
		start = () => agent.continue();
	}
	const got = result as { value: Static<O> } | null;
	if (got) return { type: "submitted", value: got.value, turns };
	if (turns >= limit) return { type: "failed", kind: "turn_limit", error: `no result after ${limit} turns`, turns };
	const said = textOf(agent.state.messages.at(-1));
	return said ? { type: "question", message: said, turns } : { type: "failed", kind: "no_result", error: "ended without a result or a message", turns };
}
