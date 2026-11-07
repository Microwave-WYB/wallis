// Runs the SIDERIUS example end to end with scripted agents and scripts.
// No model, network or device: this checks that the declarations, the loop
// and the carried state fit together, not SIDERIUS itself.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Json } from "../src/sdk/index.ts";
import { type AgentCall, conversation, FakeExecutor, FakeScripts, runWorkflow, type ScriptCall } from "../src/host/index.ts";

const workflow = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../.agents/workflows/siderius/workflow.ts");

const input = {
	task: "denoise single-cell expression profiles",
	maxIterations: 7,
	targetScore: null,
	evidence: { dataAnalysis: true, literature: true, order: "parallel", literatureMaxRounds: 2 },
	stops: { noImprovementBodies: 0, judgeCriterion: "", judgeOnMet: "stop" },
	maxProposalAttempts: 3,
	maxImplAttempts: 3,
	tuning: {
		maxRounds: 2,
		maxFailRounds: 3,
		attemptsPerTrialRound: 3,
		attemptsPerFormalRound: 5,
		trialMinutes: 2,
		formalMinutes: 5,
		trialMaxEpochs: 1,
		formalMaxEpochs: 2,
		vramBudgetGb: 24,
	},
};

const finding = (i: number, statement: string) => ({ kind: "finding", statement, strength: 3, evidence_iters: [i], model_type: `m${i}` });

function agents(overrides: Record<string, unknown> = {}) {
	let proposals = 0;
	return new FakeExecutor({
		interpret: (call: AgentCall) => {
			const i = (call.input as { iteration: number }).iteration;
			return {
				output: {
					take_home: `iteration ${i}`,
					key_findings: [finding(i, `f${i}a`), finding(i, `f${i}b`)],
					prediction_outcomes: i === 0 ? [] : ["confirmed"],
					information_gain: i === 0 ? 0 : 0.5,
					legacy_prediction_pool: { confirmed: 1 },
					analysis_brief: "look at sparsity",
				},
			};
		},
		consolidate_findings: (call: AgentCall) => {
			const { current, incoming, max } = call.input as { current: Json[]; incoming: Json[]; max: number };
			const all = [...current, ...incoming];
			return { output: { items: all.slice(-max), archived: all.slice(0, Math.max(0, all.length - max)) } };
		},
		data_analysis: (call: AgentCall) => ({
			output: { evidence: [{ at: (call.input as { at: string }).at, source: "data_analysis", content: "sparsity is 93%", source_ref: "skill:sparsity", confidence: 0.8 }] },
		}),
		literature_review: (call: AgentCall) => ({
			output: {
				evidence: [{ at: (call.input as { at: string }).at, source: "literature", content: "zero-inflated losses help", source_ref: "arXiv:1234.5678", confidence: 0.6 }],
				search_rounds_used: 1,
			},
		}),
		evidence_judge: { output: { brief: "use a zero-inflated loss", kept: ["arXiv:1234.5678"], stop: { recommend: false, reason: "" } } },
		propose: () => {
			const n = proposals++;
			return {
				output: {
					model_name: `Model ${n}`,
					model_type: `m${n}`,
					output_type: "denoised",
					model_description: `model ${n}`,
					mathematical_definition: "y = f(x)",
					motivation: "evidence",
					baseline_config: { lr: 0.001 },
					prediction: { statement: "beats SOTA", expected_score: 0.9 },
				},
			};
		},
		implement: { output: { model_file_path: "plugins/model.py", config_path: "plugins/config.yaml", capability_metadata: {} } },
		// The first review of each candidate fails, the retry passes.
		validate: [
			{ output: { passed: false, error: "gradient does not flow", error_signatures: [{ failure_class: "gradient", top_user_frame: "forward", error_type: "AssertionError", short_message: "no grad" }] } },
			{ output: { passed: true, error: null, error_signatures: [] } },
			{ output: { passed: false, error: "gradient does not flow", error_signatures: [{ failure_class: "gradient", top_user_frame: "forward", error_type: "AssertionError", short_message: "no grad" }] } },
			{ output: { passed: true, error: null, error_signatures: [] } },
		],
		tune_planner: { output: { config: { lr: 0.01 }, rationale: "try a larger step" } },
		tune_reflector: { output: { notes: "ok", physical_rejections: [] } },
		...(overrides as object),
	});
}

function scripts() {
	let evaluations = 0;
	return new FakeScripts({
		metric_order: { output: { metric_id: "mse_gain", direction: "higher_is_better" }, minutes: 0 },
		validate: { output: { passed: true, error: null, checks: { plugin_loads: true } }, minutes: 1 },
		train: (call: ScriptCall) => ({ output: { status: "ok", checkpoint: `ck-${(call.args as { scope: string }).scope}`, minutes: 2 }, minutes: 2 }),
		// Scores rise, then dip: the cache must keep the best plus the current model.
		evaluate: () => {
			const n = evaluations++;
			return { output: { scoreable: true, metric_id: "mse_gain", score: [0.1, 0.2, 0.3, 0.9, 0.8, 0.7, 0.05, 0.06, 0.4, 0.5, 0.2, 0.25, 0.01, 0.02][n] ?? 0 }, minutes: 1 };
		},
		health: { output: { valid: true, policy: "blocking", failed_checks: [{ check_name: "variance_collapse", metrics: { ratio: 0.1 } }] }, minutes: 1 },
		fingerprint: (call: ScriptCall) => {
			const args = call.args as { model_type: string; iteration: number };
			return {
				output: { entries: [{ model_type: args.model_type, iteration: args.iteration, signature: "var<0.2", check_name: "variance_collapse", count: 1, human_readable: "variance collapsed" }] },
				minutes: 0,
			};
		},
	});
}

function projectRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "wallis-siderius-"));
	mkdirSync(join(root, "siderius"));
	writeFileSync(join(root, "siderius/data_scope.json"), JSON.stringify(["data/train.h5ad"]));
	writeFileSync(join(root, "siderius/health_config.yaml"), "gates: [variance_collapse]\n");
	writeFileSync(join(root, "siderius/advice.md"), "Prefer simple losses.\n");
	return root;
}

test("the SIDERIUS workflow runs end to end on scripted agents and scripts", async () => {
	const root = projectRoot();

	const executor = agents();
	const runner = scripts();
	const result = await runWorkflow({ workflow, dir: join(root, "run"), executor, scripts: runner, input, root, seed: 11, inboxPollMs: null });
	assert.equal(result.outcome?.type, "done", JSON.stringify(result.status));
	const out = (result.outcome as unknown as { value: { stop_reason: string; iterations: number; incumbent: { score: number } } }).value;
	assert.equal(out.stop_reason, "iterations_exhausted");
	assert.equal(out.iterations, 7);

	const { state } = JSON.parse(result.snapshot);
	// Knowledge cache: top 4 by valid formal score plus the current model.
	assert.deepEqual(
		state.knowledge_cache.map((e: { model_type: string }) => e.model_type),
		["m1", "m2", "m4", "m5", "m6"],
	);
	assert.equal(out.incumbent.score, 0.9);
	assert.ok(state.findings.length <= 8);
	assert.ok(state.findings_archive.length > 0);
	assert.equal(state.runs.length, 7);
	assert.equal(state.prediction_version, 2);
	assert.deepEqual(state.prediction_v1, { confirmed: 1 });
	assert.deepEqual(state.prediction_v2, { confirmed: 6 });
	assert.equal(state.info_gain_v2, 3);
	assert.equal(state.error_signatures.length, 1);
	assert.deepEqual(Object.keys(state.collapse_history).sort(), ["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);

	// The judge saw the capped projection, never the confidence.
	for (const call of executor.calls.filter((c) => c.agent === "evidence_judge")) {
		assert.ok(call.view.length <= 4000);
		assert.doesNotMatch(call.view, /confidence/);
	}
	const lastJudge = executor.calls.filter((c) => c.agent === "evidence_judge").at(-1)!;
	assert.ok((lastJudge.omitted.evidence ?? 0) > 0 || lastJudge.view.split("\n").length - 2 <= 24);

	// Each candidate: Trial rounds, then one forced Formal round.
	const scopes = runner.calls.filter((c) => c.script === "train").map((c) => (c.args as { scope: string }).scope);
	assert.deepEqual(scopes.slice(0, 2), ["trial", "formal"]);
	// Compute minutes reach the scripts and shrink as they are spent.
	const budgets = runner.calls.map((c) => c.computeMinutes!);
	assert.equal(budgets[0], 24 * 60);
	assert.ok(budgets.at(-1)! < budgets[0]!);
	// Every merge stayed under the cap and spend was tracked.
	assert.ok(JSON.parse(result.snapshot).merge_calls.findings <= 60);
	assert.ok(JSON.parse(result.snapshot).spent.usd > 0);
});

test("JudgeStop request_input: the stop-check node asks the operator, and the reply decides", async () => {
	const root = projectRoot();
	const dir = join(root, "run");
	const question = "The judge recommends stopping: the evidence repeats. Stop the loop, or continue?";
	const make = () =>
		agents({
			evidence_judge: { output: { brief: "nothing new", kept: [], stop: { recommend: true, reason: "the evidence repeats" } } },
			stop_check: conversation({ idle: question }, { submit: { decision: "stop", note: "operator agreed" } }),
		});
	const askInput = { ...input, stops: { noImprovementBodies: 0, judgeCriterion: "stop when evidence repeats", judgeOnMet: "request_input" } };
	const first = await runWorkflow({ workflow, dir, executor: make(), scripts: scripts(), input: askInput, root, seed: 11, inboxPollMs: null });
	assert.deepEqual(first.status, { type: "idle", reason: null });
	const asking = first.run.nodes.find((n) => n.agent === "stop_check")!;
	assert.deepEqual(asking.status, { type: "node_idle", last_message: question });

	const executor = make();
	const done = await runWorkflow({ workflow, dir, executor, scripts: scripts(), root, sends: [{ node: asking.id, text: "yes, stop" }], inboxPollMs: null });
	const out = (done.outcome as unknown as { value: { stop_reason: string; iterations: number } }).value;
	assert.equal(out.stop_reason, "operator_stop");
	assert.equal(out.iterations, 2);
	// Only the stop-check conversation continued; nothing completed ran again.
	assert.deepEqual(executor.calls.map((c) => [c.agent, c.transcript.length]), [["stop_check", 2]]);
});
