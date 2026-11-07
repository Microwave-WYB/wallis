// The micro-agent unit: one pi agent, one job, a typed result.
//
// - pi-agent-core's `Agent`, not the coding agent: no built-in tools, no
//   AGENTS.md / CLAUDE.md, no extensions or skills. It sees only `system`,
//   its input and the tools you pass.
// - The result comes back through a `submit_result` tool whose parameters
//   are the TypeBox output schema; a mismatch goes back to the model as a
//   tool error and it retries.
// - Every request ends with "[Turn k of N]" on the newest message.
// - Optional: transient-error retries with backoff, and a checkpoint file
//   so a re-run continues the conversation instead of starting over.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";

/** pi-ai's model registry: `builtinModels()` for real providers, `createModels()` + faux in tests. */
export interface Models {
	getModel(provider: string, id: string): unknown;
	streamSimple: (...args: never[]) => unknown;
}

export interface AgentSpec<O extends TSchema> {
	/** `provider/model`, e.g. `anthropic/claude-sonnet-5-5`. */
	readonly model: string;
	readonly system: string;
	readonly output: O;
	readonly tools?: AgentTool[];
	/** Model turns before giving up. Default 12. */
	readonly maxTurns?: number;
	/** Conversation saved after every turn; a re-run with the same file continues from it. */
	readonly checkpoint?: string;
	/** Waits (ms) before retrying a transient provider error. Default 5 s, 30 s, 2 min. */
	readonly retries?: readonly number[];
	readonly log?: (line: string) => void;
}

export class AgentError extends Error {}

/** Rate limits, overload, 5xx, timeouts, the network: retry. Auth, billing, unknown model: do not. */
export function transient(message: string): boolean {
	if (/\b(401|402|403|404|412)\b|billing|suspended|invalid api key|not found/i.test(message)) return false;
	return /\b(408|429|5\d\d)\b|overloaded|rate.?limit|timed? ?out|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|fetch failed/i.test(message);
}

/** The `submit_result` tool: validates against the schema; errors go back to the model. */
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

/** Runs one agent on `input` and returns its validated result. */
export async function runAgent<O extends TSchema>(models: Models, spec: AgentSpec<O>, input: unknown): Promise<Static<O>> {
	const [provider, ...rest] = spec.model.split("/");
	const model = models.getModel(provider!, rest.join("/"));
	if (!model) throw new AgentError(`unknown model ${spec.model}`);
	const limit = spec.maxTurns ?? 12;
	const log = spec.log ?? (() => {});
	const saved = spec.checkpoint && existsSync(spec.checkpoint) ? (JSON.parse(readFileSync(spec.checkpoint, "utf8")) as { messages: AgentMessage[]; turns: number }) : null;
	let turns = saved?.turns ?? 0;
	let result: { value: Static<O> } | null = null;

	const agent = new Agent({
		initialState: {
			systemPrompt: spec.system,
			model: model as never,
			thinkingLevel: "off",
			tools: [...(spec.tools ?? []), submitTool(spec.output, (value) => (result = { value }))],
			messages: saved?.messages ?? [],
		},
		streamFn: models.streamSimple.bind(models) as never,
		toolExecution: "sequential",
		transformContext: async (messages) => quota(messages, turns + 1, limit),
	});
	const save = () => {
		if (!spec.checkpoint) return;
		mkdirSync(dirname(spec.checkpoint), { recursive: true });
		writeFileSync(`${spec.checkpoint}.tmp`, JSON.stringify({ messages: agent.state.messages, turns }));
		renameSync(`${spec.checkpoint}.tmp`, spec.checkpoint);
	};
	agent.subscribe((event) => {
		if (event.type !== "turn_end") return;
		const last = agent.state.messages.at(-1);
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) return;
		turns++;
		save();
		if (turns >= limit && !result) agent.abort();
	});

	// A restored conversation continues; a fresh one starts from the input.
	let start = saved && saved.messages.length > 0 ? () => agent.continue() : () => agent.prompt(`Input:\n${JSON.stringify(input, null, 2)}`);
	if (saved) log(`resumed after turn ${saved.turns}`);
	const delays = spec.retries ?? [5_000, 30_000, 120_000];
	for (let attempt = 0; ; attempt++) {
		let thrown: string | null = null;
		try {
			await start();
			await agent.waitForIdle();
		} catch (e) {
			// Our own abort at the turn limit is reported below; anything else is an error to classify.
			if (turns < limit) thrown = e instanceof Error ? e.message : String(e);
		}
		const last = agent.state.messages.at(-1);
		const error = thrown ?? (last?.role === "assistant" && last.stopReason === "error" ? (last.errorMessage ?? "provider error") : null);
		if (!error) break;
		if (!transient(error) || attempt >= delays.length) throw new AgentError(error);
		log(`transient error (${error}); retry ${attempt + 1} in ${delays[attempt]} ms`);
		await new Promise((r) => setTimeout(r, delays[attempt]));
		if (agent.state.messages.at(-1)?.role === "assistant") agent.state.messages = agent.state.messages.slice(0, -1); // drop the failed reply
		start = () => agent.continue();
	}
	const got = result as { value: Static<O> } | null;
	if (!got) throw new AgentError(turns >= limit ? `no result after ${limit} turns` : "ended its turn without submit_result");
	return got.value;
}
