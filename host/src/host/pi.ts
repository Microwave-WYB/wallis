// The pi executor: in process, through pi-agent-core's Agent. No built-in
// tools and no ambient context (no AGENTS.md or CLAUDE.md, no extensions or
// skills): the agent gets its declared prompt, its input and view, and the
// tools of the wallis tool layer, nothing else.

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Json } from "../sdk/index.ts";
import type { Usage } from "./core.ts";
import type { Capabilities, Executor, NodeSession, NodeSpec, TurnResult } from "./executor.ts";
import { buildNodeTools, type NodeTools, type ToolLayerOptions } from "./tools.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Thinking = (typeof THINKING)[number];

/** What pi-ai's model registry provides: `createModels()` or `builtinModels()` with providers set. */
export interface PiModels {
	getModel(provider: string, id: string): Model<never> | Model<string> | undefined;
	streamSimple: (...args: never[]) => unknown;
}

export interface PiExecutorOptions extends ToolLayerOptions {
	readonly models: PiModels;
	readonly getApiKey?: (provider: string) => string | undefined;
}

/** `provider/model[:thinking]`; a trailing `:<level>` is a thinking level only if it names one. */
export function parseModel(text: string): { provider: string; id: string; thinking: Thinking | undefined } {
	const slash = text.indexOf("/");
	if (slash <= 0) throw new Error(`model ${text} is not provider/model`);
	let rest = text.slice(slash + 1);
	let thinking: Thinking | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon > 0 && (THINKING as readonly string[]).includes(rest.slice(colon + 1))) {
		thinking = rest.slice(colon + 1) as Thinking;
		rest = rest.slice(0, colon);
	}
	return { provider: text.slice(0, slash), id: rest, thinking };
}

const SYSTEM = `You are one node of a wallis workflow. Work only with the tools you are given.
When you are done, call submit_result with a result that matches its schema; if it does not match, you get the errors and may resubmit.
If you cannot continue without an answer from the human, end your turn with your question as plain text instead of calling submit_result.`;

function firstPrompt(spec: NodeSpec): string {
	const parts = [`Input:\n${JSON.stringify(spec.input, null, 2)}`];
	if (spec.view) parts.push(`Your view of the run state (also available through state_read):\n${spec.view}`);
	// A session rebuilt after a restart carries the conversation so far in its first prompt.
	if (spec.transcript.length > 0) {
		parts.push(
			`Conversation so far:\n${spec.transcript.map((m) => `${m.role === "user" ? "The human" : "You"}: ${m.text}`).join("\n")}`,
		);
	}
	return parts.join("\n\n");
}

function textOf(message: AgentMessage | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
}

class PiNodeSession implements NodeSession {
	readonly #spec: NodeSpec;
	readonly #tools: NodeTools;
	readonly #agent: Agent;
	readonly #options: PiExecutorOptions;
	#model: string;
	#started = false;
	#limitHit = false;

	constructor(spec: NodeSpec, tools: NodeTools, options: PiExecutorOptions) {
		this.#spec = spec;
		this.#tools = tools;
		this.#options = options;
		this.#model = spec.model;
		const { model, thinking } = this.#resolve(spec.model);
		this.#agent = new Agent({
			initialState: { systemPrompt: `${SYSTEM}\n\n${spec.declaration.prompt}`, model: model as never, thinkingLevel: thinking ?? "off", tools: tools.agentTools() },
			streamFn: (options.models.streamSimple as (...a: unknown[]) => never).bind(options.models),
			getApiKey: options.getApiKey,
			toolExecution: "sequential",
		});
		let turns = 0;
		this.#agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const said = textOf(event.message);
				if (said) spec.log({ kind: "assistant", text: said, model: this.#model });
			}
			if (event.type === "turn_end") {
				turns++;
				if (turns >= spec.maxTurns && this.#tools.submitted === undefined) {
					this.#limitHit = true;
					this.#agent.abort();
				}
			}
		});
	}

	#resolve(text: string) {
		const { provider, id, thinking } = parseModel(text);
		const model = this.#options.models.getModel(provider, id);
		if (!model) throw new Error(`unknown model ${provider}/${id}`);
		return { model, thinking };
	}

	async turn(message?: string): Promise<TurnResult> {
		const before = this.#agent.state.messages.length;
		const prompt = this.#started ? (message ?? "") : message === undefined ? firstPrompt(this.#spec) : `${firstPrompt(this.#spec)}\n\nThe human: ${message}`;
		this.#started = true;
		try {
			await this.#agent.prompt(prompt);
			await this.#agent.waitForIdle();
		} catch (error) {
			return { type: "executor_error", error: error instanceof Error ? error.message : String(error) };
		}
		const fresh = this.#agent.state.messages.slice(before);
		const assistant = fresh.filter((m) => m.role === "assistant");
		const usage: Usage = {
			usd: assistant.reduce((n, m) => n + (m.role === "assistant" ? (m.usage?.cost?.total ?? 0) : 0), 0),
			tokens: assistant.reduce((n, m) => n + (m.role === "assistant" ? (m.usage?.totalTokens ?? 0) : 0), 0),
			turns: assistant.length,
		};
		if (this.#tools.submitted !== undefined) {
			const output = this.#tools.submitted;
			this.#tools.submitted = undefined;
			return { type: "submitted", output, emits: this.#tools.emits.splice(0), usage };
		}
		if (this.#limitHit) return { type: "agent_error", error: `maxTurns exceeded (${this.#spec.maxTurns})`, usage };
		const last = assistant.at(-1);
		if (last?.role === "assistant" && last.stopReason === "error") {
			// Provider, auth or billing: not the agent's failure.
			return { type: "executor_error", error: last.errorMessage ?? "provider error" };
		}
		const said = textOf(last);
		if (last?.role === "assistant" && last.stopReason === "aborted") return { type: "ended", message: said || "(interrupted)", usage };
		if (!said) return { type: "agent_error", error: "ended its turn without a result or a message", usage };
		return { type: "ended", message: said, usage };
	}

	rebind(model: string): void {
		const { model: next, thinking } = this.#resolve(model);
		this.#agent.state.model = next as never;
		if (thinking) this.#agent.state.thinkingLevel = thinking;
		this.#model = model;
	}

	steer(message: string): void {
		this.#agent.steer({ role: "user", content: message, timestamp: Date.now() } as never);
	}

	interrupt(): void {
		this.#agent.abort();
	}

	handle(): Json {
		return { executor: "pi", node: this.#spec.id, model: this.#model, messages: this.#agent.state.messages.length, tools: this.#tools.names };
	}

	async close(): Promise<void> {
		this.#agent.abort();
		await this.#tools.close();
	}
}

export class PiExecutor implements Executor {
	readonly id = "pi";
	readonly capabilities: Capabilities = { structuredOutput: true, toolCalls: true };
	readonly #options: PiExecutorOptions;

	constructor(options: PiExecutorOptions) {
		this.#options = options;
	}

	async start(spec: NodeSpec): Promise<NodeSession> {
		const tools = await buildNodeTools(spec, this.#options);
		return new PiNodeSession(spec, tools, this.#options);
	}
}
