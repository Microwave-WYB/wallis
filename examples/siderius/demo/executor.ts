// The demo's scripted agents: pi-ai's faux provider answers every agent from its input, so no
// model is called and no key is needed. Each agent is told apart by its prompt's title.
// Everything follows from the input (never from call order), so a resumed run gets the same
// answers. The judge recommends stopping at iterations 2 and 4.

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "wallis/testing";

type Part = { type: string; text?: string };
type Msg = { role: string; content: string | Part[]; toolName?: string };
const text = (m: Msg | undefined) => (m === undefined ? "" : typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
/** An agent returns its output through the submit_result tool. */
const submit = (result: unknown) => call("submit_result", { result });

/** The agent's input: the first JSON object in its first user message. */
function inputOf(messages: Msg[]): Record<string, unknown> {
	const t = text(messages.find((m) => m.role === "user" && /Your (next )?input:/.test(text(m))));
	const start = t.indexOf("{");
	let depth = 0;
	for (let i = start; i < t.length; i++) {
		if (t[i] === "{") depth++;
		if (t[i] === "}" && --depth === 0) return JSON.parse(t.slice(start, i + 1));
	}
	throw new Error("no input");
}

const finding = (i: number, statement: string) => ({ kind: "finding", statement, strength: 3, evidence_iters: [i], model_type: `m${i - 1}` });
const PROPOSALS = ["a plain autoencoder", "a zero-inflated negative-binomial decoder", "a ZINB decoder with a variance penalty", "a diffusion denoiser", "a graph-smoothed autoencoder", "a count-splitting ensemble", "a low-rank baseline"];

function respond(context: { messages: Msg[] }) {
	const system = text(context.messages.find((m) => m.role === "system"));
	const messages = context.messages.filter((m) => m.role !== "system");
	const input = inputOf(messages);
	const agent = /# ([^(\n]+) \(SIDERIUS/.exec(system)?.[1]?.trim() ?? "?";
	switch (agent) {
		case "Result interpretation": {
			const i = input.iteration as number;
			return submit({ take_home: `iteration ${i}`, key_findings: i === 0 ? [] : [finding(i, `m${i - 1} learns the dropout pattern`)], legacy_prediction_pool: { confirmed: 1 }, analysis_brief: "look at sparsity" });
		}
		case "Findings consolidation": {
			const { current, incoming, max } = input as { current: unknown[]; incoming: unknown[]; max: number };
			const all = [...current, ...incoming];
			return submit({ items: all.slice(-max), archived: all.slice(0, Math.max(0, all.length - max)) });
		}
		case "Data analysis":
			return submit({ evidence: [{ at: input.at, source: "data_analysis", content: "93% of counts are zero", source_ref: "sparsity.py", confidence: 0.8 }] });
		case "Literature review":
			return submit({ evidence: [{ at: input.at, source: "literature", content: "zero-inflated losses help on sparse counts", source_ref: "arXiv:1234.5678", confidence: 0.6 }], search_rounds_used: 1 });
		case "Evidence judge": {
			const stop = input.iteration === 2 || input.iteration === 4;
			return submit({ brief: "use a zero-inflated loss", kept: ["arXiv:1234.5678"], stop: { recommend: stop, reason: stop ? "the evidence has repeated for two iterations" : "" } });
		}
		case "Model proposal": {
			const n = input.iteration as number;
			const failed = (input.previous_failures as string[]).length;
			return submit({ model_name: PROPOSALS[n] ?? `model ${n}`, model_type: `m${n}`, output_type: "denoised", model_description: PROPOSALS[n] ?? "", mathematical_definition: "y = f(x)", motivation: failed ? "after a failed attempt" : "evidence", baseline_config: { lr: 0.001 }, prediction: { statement: "beats the incumbent", expected_score: 0.9 } });
		}
		case "Implementation": {
			// Writes the plugin in its workspace, then returns it: an Artifact output.
			const wrote = messages.some((m) => m.role === "toolResult" && m.toolName === "write");
			const modelType = (input.proposal as { model_type: string }).model_type;
			if (!wrote) return call("write", { path: "model.py", content: `class Model: pass  # ${modelType}\n` });
			return submit({ model: "/w/model.py", capability_metadata: {} });
		}
		case "Validation review":
			return submit({ passed: true, error: null, error_signatures: [] });
		case "Tuning planner":
			return submit({ config: { lr: input.is_trial ? 0.01 : 0.005 }, rationale: "try a larger step" });
		case "Tuning reflector":
			return submit({ notes: "ok", physical_rejections: [] });
	}
	throw new Error(`no script for agent ${agent}`);
}

const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 400_000 }] });
faux.setResponses(Array.from({ length: 5000 }, () => respond as never));

export default function create() {
	const models = createModels();
	models.setProvider(faux.provider);
	return { models };
}
