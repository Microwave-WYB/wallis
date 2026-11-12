// SIDERIUS's agents, scripted (pi's faux provider; no model is called). Each agent is told apart by
// its prompt's title, answers from its input, and keeps counters here (the test runs in process).
// `script` lets a test change what the judge recommends; `reset()` starts the counters over.

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../src/testing.ts";

type Part = { type: string; text?: string; name?: string };
type Msg = { role: string; content: string | Part[]; toolName?: string };
const text = (m: Msg | undefined) => (m === undefined ? "" : typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const submit = (result: unknown) => call("submit_result", { result });

export const script = { judgeStops: false };
let proposals = 0;
let validations = 0;
export const seen: Record<string, unknown[]> = {};
export function reset() {
	proposals = 0;
	validations = 0;
	for (const k of Object.keys(seen)) delete seen[k];
}

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
const signature = (frames: string[]) => ({ failure_class: "gradient", top_user_frame: "forward", error_type: "AssertionError", short_message: "no grad", last_frames: frames });

function respond(context: { messages: Msg[] }) {
	const system = text(context.messages.find((m) => m.role === "system"));
	const messages = context.messages.filter((m) => m.role !== "system");
	const input = inputOf(messages);
	const agent = /# ([^(\n]+) \(SIDERIUS/.exec(system)?.[1]?.trim() ?? "?";
	(seen[agent] ??= []).push(input);
	switch (agent) {
		case "Result interpretation": {
			const i = input.iteration as number;
			return submit({ take_home: `iteration ${i}`, key_findings: [finding(i, `f${i}a`), finding(i, `f${i}b`)], legacy_prediction_pool: { confirmed: 1 }, analysis_brief: "look at sparsity" });
		}
		case "Findings consolidation": {
			const { current, incoming, max } = input as { current: unknown[]; incoming: unknown[]; max: number };
			const all = [...current, ...incoming];
			return submit({ items: all.slice(-max), archived: all.slice(0, Math.max(0, all.length - max)) });
		}
		case "Data analysis":
			return submit({ evidence: [{ at: input.at, source: "data_analysis", content: "sparsity is 93%", source_ref: "skill:sparsity", confidence: 0.8 }] });
		case "Literature review":
			return submit({ evidence: [{ at: input.at, source: "literature", content: "zero-inflated losses help", source_ref: "arXiv:1234.5678", confidence: 0.6 }], search_rounds_used: 1 });
		case "Evidence judge":
			return submit({ brief: "use a zero-inflated loss", kept: ["arXiv:1234.5678"], stop: { recommend: script.judgeStops, reason: script.judgeStops ? "the evidence repeats" : "" } });
		case "Model proposal": {
			const n = proposals++;
			return submit({ model_name: `Model ${n}`, model_type: `m${n}`, output_type: "denoised", model_description: `model ${n}`, mathematical_definition: "y = f(x)", motivation: "evidence", baseline_config: { lr: 0.001 }, prediction: { statement: "beats SOTA", expected_score: 0.9 } });
		}
		case "Implementation": {
			// Writes the plugin in its workspace, then returns it: a workspace output Artifact.
			const wrote = messages.some((m) => m.role === "toolResult" && m.toolName === "write");
			const modelType = (input.proposal as { model_type: string }).model_type;
			if (!wrote) return call("write", { path: "model.py", content: `class Model: pass  # ${modelType}\n` });
			return submit({ model: "/w/model.py", capability_metadata: {} });
		}
		case "Validation review": {
			// The first review of the first two candidates fails, the retry passes.
			const n = validations++;
			if (n === 0) return submit({ passed: false, error: "gradient does not flow", error_signatures: [signature(["forward"])] });
			if (n === 2) return submit({ passed: false, error: "gradient does not flow", error_signatures: [signature(["forward", "loss"])] });
			return submit({ passed: true, error: null, error_signatures: [] });
		}
		case "Tuning planner":
			return submit({ config: { lr: 0.01 }, rationale: "try a larger step" });
		case "Tuning reflector":
			return submit({ notes: "ok", physical_rejections: [] });
	}
	throw new Error(`no script for agent ${agent}`);
}

export const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 400_000 }] });
faux.setResponses(Array.from({ length: 5000 }, () => respond as never));

export default function create() {
	const models = createModels();
	models.setProvider(faux.provider);
	return { models };
}
