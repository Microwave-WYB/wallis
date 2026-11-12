// The SIDERIUS example (examples/siderius/workflow.ts, unchanged) end to end on scripted agents
// (pi's faux provider) and scripted commands (tiny python3 scripts in place of trainer/ and
// checks/), in real sandboxes. This checks that the loop, the carried history (the body's local
// variables) and the nodes fit together, not SIDERIUS itself; ported from v1's siderius test.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runPaths, runsDir } from "../src/host/runs.ts";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { attach, MessageRejected, run } from "../src/index.ts";
import { RunView } from "../src/status.ts";
import { reset, script, seen } from "./fixtures/siderius-executor.ts";
import { here, project } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const example = join(here, "../../examples/siderius");

const input = {
	task: "denoise single-cell expression profiles",
	seed: 11,
	maxIterations: 7,
	targetScore: null,
	evidence: { dataAnalysis: true, literature: true, order: "parallel" as const, literatureMaxRounds: 2 },
	stops: { noImprovementBodies: 0, judgeCriterion: "", judgeOnMet: "stop" as const },
	maxProposalAttempts: 3,
	maxImplAttempts: 3,
	tuning: { maxRounds: 2, maxFailRounds: 3, attemptsPerTrialRound: 1, attemptsPerFormalRound: 5, trialMinutes: 2, formalMinutes: 5, trialMaxEpochs: 1, formalMaxEpochs: 2, vramBudgetGb: 24 },
};

function files(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else out[relative(example, p)] = readFileSync(p, "utf8");
		}
	};
	walk(dir);
	return out;
}

async function siderius() {
	const own = files(example);
	const scripted = (name: string) => readFileSync(join(here, "fixtures/siderius", name), "utf8");
	const root = project(
		{
			"siderius/workflow.ts": own["workflow.ts"]!,
			...Object.fromEntries(Object.entries(own).filter(([k]) => k.startsWith("prompts/") || k.startsWith("tools/")).map(([k, v]) => [`siderius/${k}`, v])),
			"siderius/trainer/train.py": scripted("train.py"),
			"siderius/trainer/evaluate.py": scripted("evaluate.py"),
			...Object.fromEntries(["health.py", "fingerprint.py", "metric_order.py", "validate.py"].map((f) => [`siderius/checks/${f}`, scripted(f)])),
			"siderius/config/data_scope.json": JSON.stringify(["data/train.h5ad"]),
			"siderius/config/health_config.yaml": "gates: [variance_collapse]\n",
			"siderius/config/advice.md": "Prefer simple losses.\n",
			"siderius/data/train.h5ad": "cells",
		},
		{ models: { default: "faux/m" }, executor: join(here, "fixtures/siderius-executor.ts") },
	);
	reset();
	const wf = ((await import(pathToFileURL(join(root, "siderius/workflow.ts")).href)) as { default: typeof import("../../examples/siderius/workflow.ts").default }).default;
	return { root, wf };
}

type Carried = {
	runs: unknown[];
	knowledge_cache: { model_type: string; key_findings: unknown[]; error_signatures: unknown[] }[];
	findings_archive: unknown[];
	collapse_history: Record<string, unknown>;
	prediction: { version: number; v1: unknown; v2: unknown; info_gain_v2: number };
};

test("the SIDERIUS workflow runs end to end on scripted agents and commands", { skip, timeout: 300_000 }, async () => {
	const { root, wf } = await siderius();
	const r = await run(wf, input);
	const out = r.output as unknown as { stop_reason: string; iterations: number; incumbent: { score: number }; carried: Carried };
	assert.equal(out.stop_reason, "iterations_exhausted");
	assert.equal(out.iterations, 7);
	const state = out.carried;
	// Knowledge cache: top 4 by valid formal score plus the current model.
	assert.deepEqual(state.knowledge_cache.map((e) => e.model_type), ["m1", "m2", "m4", "m5", "m6"]);
	assert.equal(out.incumbent.score, 0.9);
	for (const entry of state.knowledge_cache) assert.ok(entry.key_findings.length <= 8);
	assert.equal(state.knowledge_cache.find((e) => e.model_type === "m5")!.key_findings.length, 2);
	assert.ok(state.findings_archive.length > 0);
	assert.equal(seen["Findings consolidation"]!.length, 6, "one call per model with a cache hit");
	assert.equal(state.runs.length, 7);
	assert.equal(state.prediction.version, 2);
	assert.deepEqual(state.prediction.v1, { confirmed: 1 });
	// The prediction rule, in body code: only m1 beat the incumbent.
	assert.deepEqual(state.prediction.v2, { confirmed: 1, refuted: 5 });
	assert.ok(Math.abs(state.prediction.info_gain_v2 - 0.7) < 1e-9);
	// Error signatures live in their model's entry, deduped by the 3-field key.
	assert.deepEqual(state.knowledge_cache.find((e) => e.model_type === "m1")!.error_signatures, [
		{ failure_class: "gradient", top_user_frame: "forward", error_type: "AssertionError", short_message: "no grad", last_frames: ["forward", "loss"], evidence_iters: [1] },
	]);
	// Collapse history is pruned to the last 3 iterations.
	assert.deepEqual(Object.keys(state.collapse_history).sort(), ["m4", "m5", "m6"]);
	// The judge gets the capped projection the body builds, never the confidence.
	for (const judged of seen["Evidence judge"] as { evidence: unknown[]; omitted: number }[]) {
		assert.ok(JSON.stringify(judged.evidence).length <= 4000);
		assert.ok(judged.evidence.length <= 24);
		assert.doesNotMatch(JSON.stringify(judged), /confidence/);
		assert.ok(judged.omitted >= 0);
	}
	assert.equal((seen["Evidence judge"]!.at(-1) as { evidence: unknown[] }).evidence.length, 14, "two entries per iteration");
	// Agents get the carried history in their input.
	assert.equal((seen["Result interpretation"]!.at(-1) as { history: { runs: unknown[] } }).history.runs.length, 6);
	// Each candidate: a Trial round, then the forced Formal round; train mounts the implementor's plugin.
	const v = new RunView(runPaths(join(runsDir(root), r.id)));
	const trains = v.calls.filter((c) => c.name.startsWith("trainScript"));
	const scopes = trains.map((c) => (c.input as { scope: string }).scope);
	assert.deepEqual([scopes.filter((s) => s === "trial").length, scopes.filter((s) => s === "formal").length], [7, 7]);
	const plugin = (trains[0]!.input as { model: { name: string; media: string } }).model;
	assert.deepEqual([plugin.name, plugin.media], ["model.py", "text/x-python"], "the implementor's workspace file, as an artifact");
	assert.equal(v.calls.filter((c) => c.kind === "agent" && c.name.startsWith("validator")).length, 9, "two candidates needed a second review");
});

test("JudgeStop request_input: the question goes to the caller's outbox, the answer to the body's mailbox", { skip, timeout: 300_000 }, async () => {
	const { root, wf } = await siderius();
	script.judgeStops = true;
	try {
		const finished = run(wf, { ...input, stops: { noImprovementBodies: 0, judgeCriterion: "stop when evidence repeats", judgeOnMet: "request_input" } });
		let id = "";
		for (let i = 0; i < 400 && !id; i++) {
			await new Promise((d) => setTimeout(d, 50));
			try {
				id = readdirSync(runsDir(root))[0] ?? "";
			} catch {
				// not yet
			}
		}
		const r = attach(wf, id);
		const asked = await r.next({ timeout: "120s" });
		assert.equal(asked.type, "message");
		assert.deepEqual(asked.type === "message" && [asked.outbox, asked.body], ["stop_check", { iteration: 1, criterion: "stop when evidence repeats", recommendation: "the evidence repeats" }]);
		// An answer that does not match the mailbox's schema is rejected; the right one decides.
		await assert.rejects(r.send("decision", { decision: "maybe", note: "" }), (e: unknown) => e instanceof MessageRejected && e.reason === "invalid");
		await r.send("decision", { decision: "stop", note: "the orchestrator agreed" });
		const out = (await finished).output as unknown as { stop_reason: string; iterations: number };
		assert.equal(out.stop_reason, "operator_stop");
		assert.equal(out.iterations, 2);
	} finally {
		script.judgeStops = false;
	}
});

