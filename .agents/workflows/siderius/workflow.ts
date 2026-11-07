// SIDERIUS (github.com/yuema137/SIDERIUS, commit 5ccb436) as a wallis
// workflow: the fixed iteration loop of src/workflows/model_exploration.py
// with its carried history (research_history.py), run invariants and
// accounting. The task package (models, training, Health gates) stays
// domain code behind scripts/. See MAPPING.md for what maps where and what
// is approximated.

import {
	AgentFailed,
	append,
	countByKey,
	defineAgent,
	defineMcp,
	defineModels,
	defineScript,
	defineState,
	defineTool,
	freeze,
	lastN,
	perKey,
	replace,
	topK,
	topKBy,
	union,
	dedupeBy,
	type Static,
	subWorkflow,
	sum,
	Type,
	view,
	workflow,
} from "wallis";
import mcpConfig from "./mcp.json" with { type: "json" };
import consolidatePrompt from "./consolidate-findings.md" with { type: "text" };
import dataAnalysisPrompt from "./data-analysis.md" with { type: "text" };
import evidenceJudgePrompt from "./evidence-judge.md" with { type: "text" };
import implementPrompt from "./implement.md" with { type: "text" };
import interpretPrompt from "./interpret.md" with { type: "text" };
import literaturePrompt from "./literature-review.md" with { type: "text" };
import proposePrompt from "./propose.md" with { type: "text" };
import stopCheckPrompt from "./stop-check.md" with { type: "text" };
import tunePlannerPrompt from "./tune-planner.md" with { type: "text" };
import tuneReflectorPrompt from "./tune-reflector.md" with { type: "text" };
import validatePrompt from "./validate.md" with { type: "text" };

// --- Models: one alias per SIDERIUS llm.json route ----------------------------

// configs/llm/default.json routes every role to the same model at medium
// reasoning; empty aliases fall back to `default`. Callers remap them
// (openai-moderate-v1 moves propose and validate to a larger model).
const models = defineModels({
	default: "openai/gpt-5.6-luna:medium",
	interpret: "",
	analysis: "",
	literature: "",
	judge: "",
	propose: "",
	implement: "",
	validate: "",
	tune: "",
	consolidate: "",
});

const mcp = defineMcp(mcpConfig);

// --- Schemas -----------------------------------------------------------------
//
// TypeBox Script modules: TS syntax for shapes; constrained types are
// builders passed in as the module's context.

const Int = Type.Integer();
const Strength = Type.Integer({ minimum: 1, maximum: 5 });
/** cache_entry.py: statements are capped at 500 chars. */
const Statement = Type.String({ maxLength: 500 });
/** The existing short_message (up to 120 chars) wins. */
const ShortMessage = Type.String({ maxLength: 120 });

const S = Type.Script(
	{ Int, Strength, Statement, ShortMessage },
	`
	type Score = number | null
	type Config = Record<string, number | string | boolean>

	// One iteration's summary (tuning_output_to_model_run_summary).
	type RunSummary = {
		iteration: Int, model_type: string,
		status: "tuned" | "no_candidate" | "infrastructure_abort",
		best_score: Score, best_valid_formal_score: Score,
		termination_reason: string, take_home: string
	}

	type Finding = {
		kind: "finding" | "bottleneck", statement: Statement, strength: Strength,
		evidence_iters: Int[], model_type: string
	}

	// What the validator reports; the body adds the iterations it was seen in.
	type RawSignature = {
		failure_class: string, top_user_frame: string, error_type: string,
		short_message: ShortMessage, last_frames: string[]
	}
	type ErrorSignature = {
		failure_class: string, top_user_frame: string, error_type: string,
		short_message: ShortMessage, last_frames: string[], evidence_iters: Int[]
	}

	// One per model, holding its own consolidated findings and bottlenecks (at
	// most 8 each) and its error signatures. rank_score is the best Health-valid
	// formal score, sign-normalized by the metric order (higher is better).
	type CacheEntry = {
		model_type: string, description: string, iteration: Int, rank_score: Score,
		stats: { best_score: Score, best_formal_score: Score, best_valid_formal_score: Score },
		key_findings: Finding[], bottlenecks: Finding[], error_signatures: ErrorSignature[]
	}

	type CollapseEntry = {
		model_type: string, iteration: Int, signature: string, check_name: string,
		count: Int, human_readable: string
	}

	// Union stores items in canonical order, and canonical JSON sorts keys, so
	// "at" ("iter-007") comes first and the judge's window shows the newest.
	type Evidence = {
		at: string, source: "data_analysis" | "literature", content: string,
		source_ref: string, confidence: number
	}

	// The chain formal incumbent: best Health-valid formal score.
	type Incumbent = { rank_score: number, score: number, model_type: string, iteration: Int }

	type Proposal = {
		model_name: string, model_type: string, output_type: string,
		model_description: string, mathematical_definition: string, motivation: string,
		baseline_config: Config,
		prediction: { statement: string, expected_score: number }
	}

	type Scope = "trial" | "formal"
	type Direction = "higher_is_better" | "lower_is_better"
	type HealthCheck = { check_name: string, metrics: Record<string, number> }
	type SkillInput = { skill: string, args: Record<string, string> }
	type SkillOutput = { result_ref: string, summary: string }
	`,
);

const { Score, Config, RunSummary, Finding, RawSignature, ErrorSignature, CacheEntry, CollapseEntry, Evidence, Incumbent, Proposal, Scope, Direction, HealthCheck, SkillInput, SkillOutput } = S;

// --- Scripts: the task package's domain code, with typed args and outputs ------

const trainScript = defineScript({
	name: "train",
	description: "Train one candidate config on the trial or formal scope (training_skill).",
	input: Type.Script({ Config, Scope, Int }, `{
		config: Config, scope: Scope, max_epochs: Int, time_budget_minutes: number,
		seed: Int, data_scope: string
	}`),
	output: Type.Script(`{
		status: "ok" | "oom" | "gate_refused" | "infrastructure_abort",
		checkpoint: string | null, minutes: number
	}`),
});

const evaluateScript = defineScript({
	name: "evaluate",
	description: "Score a checkpoint on the trial or formal evaluation portion (inference_skill, evaluate_metric).",
	input: Type.Script({ Scope }, `{ checkpoint: string, scope: Scope }`),
	output: Type.Script({ Score }, `{ scoreable: boolean, score: Score, metric_id: string }`),
});

const healthScript = defineScript({
	name: "health",
	description: "Run the scientific Health gates of the effective Health config (round_health.py).",
	input: Type.Script(`{ checkpoint: string, health_config: string, model_type: string }`),
	output: Type.Script({ HealthCheck }, `{ valid: boolean, policy: "blocking" | "recording", failed_checks: HealthCheck[] }`),
});

const fingerprintScript = defineScript({
	name: "fingerprint",
	description: "Turn failed Health checks into collapse fingerprints.",
	input: Type.Script({ HealthCheck, Int }, `{ failed_checks: HealthCheck[], model_type: string, iteration: Int }`),
	output: Type.Script({ CollapseEntry }, `{ entries: CollapseEntry[] }`),
});

const metricOrderScript = defineScript({
	name: "metric_order",
	description: "Reconcile the run's MetricSpec and report its direction (MetricOrder).",
	input: Type.Script(`{ data_scope: string }`),
	output: Type.Script({ Direction }, `{ metric_id: string, direction: Direction }`),
});

const validateScript = defineScript({
	name: "validate",
	description: "Deterministic validator checks 1-7 and 9.",
	input: Type.Script({ Int }, `{ model_file_path: string, probe_seed: Int }`),
	output: Type.Script(`{ passed: boolean, error: string | null, checks: Record<string, boolean> }`),
});

const runSkillScript = defineScript({
	name: "run_skill",
	description: "Serve the data-analysis tool run_skill: one authorized analysis skill under the access policy.",
	input: SkillInput,
	output: SkillOutput,
});

// --- Findings consolidation (cache_consolidator.list_merge) ---------------------

const consolidator = defineAgent(
	{ models },
	{
		name: "consolidate_findings",
		model: "consolidate",
		prompt: consolidatePrompt,
		input: Type.Object({
			model_type: Type.String(),
			kind: Type.Union([Type.Literal("finding"), Type.Literal("bottleneck")]),
			current: Type.Array(Finding),
			incoming: Type.Array(Finding),
			max: Type.Integer(),
		}),
		output: Type.Object({ items: Type.Array(Finding), archived: Type.Array(Finding) }),
		maxTurns: 1,
		needs: { structuredOutput: true },
	},
);

// --- State: SIDERIUS ChainState and its folds ---------------------------------

const state = defineState({
	// recent_tune_outputs / latest_new_summary: one summary per iteration.
	runs: append(RunSummary),
	// Per-model records; body code caps them (cap_knowledge_cache: the current
	// model plus the top 4 others) and consolidates their findings.
	knowledge_cache: replace(Type.Array(CacheEntry), []),
	// Findings dropped by consolidation or rank-pruning (cache_archive_*.json).
	findings_archive: append(Finding),
	// collapse_fingerprint_history keyed by model_type; body code prunes it
	// (3-iteration window, at most 8 entries per model).
	collapse_history: replace(Type.Record(Type.String(), Type.Array(CollapseEntry)), {}),
	// PredictionMemory: legacy v1 pool frozen, v2 outcome counts, v2 gain.
	prediction_v1: freeze(Type.Record(Type.String(), Type.Integer())),
	prediction_v2: countByKey(),
	info_gain_v2: sum(),
	prediction_version: freeze(Type.Integer(), 2),
	// Evidence for the judge projection.
	evidence: union(Evidence),
	// chain_formal_incumbent_reference.
	incumbent: topK({ k: 1, by: "rank_score", order: "descending" }, Incumbent),
});

// --- Views ---------------------------------------------------------------------

/** judge-strategies-contract.md: 4000 chars, 24 entries, no confidence or ids. */
const judgeProjection = view(state, {
	fields: ["evidence"],
	maxChars: 4000,
	maxItems: 24,
	chunk: 8,
	omit: ["confidence", "candidate_id"],
});

const interpreterView = view(state, {
	fields: ["prediction_version", "prediction_v1", "runs", "collapse_history", "knowledge_cache", "prediction_v2", "info_gain_v2"],
	maxChars: 24_000,
	maxItems: 12,
});

const proposerView = view(state, {
	fields: ["runs", "collapse_history", "knowledge_cache"],
	maxChars: 16_000,
	maxItems: 8,
});

// --- Tools ---------------------------------------------------------------------

const runSkill = defineTool({
	name: "run_skill",
	description: "Run one authorized analysis skill inside the declared data scope.",
	input: SkillInput,
	output: SkillOutput,
	script: runSkillScript.name,
});

// --- Agents: SIDERIUS nodes ----------------------------------------------------

const env = { models, state, mcp };

const interpreter = defineAgent(env, {
	name: "interpret",
	model: "interpret",
	prompt: interpretPrompt,
	input: Type.Object({ iteration: Type.Integer(), cold_start: Type.Boolean(), metric_direction: Type.String() }),
	output: Type.Object({
		take_home: Type.String(),
		key_findings: Type.Array(Finding),
		legacy_prediction_pool: Type.Record(Type.String(), Type.Integer()),
		analysis_brief: Type.String(),
	}),
	view: interpreterView,
	writes: { prediction_v1: "legacy_prediction_pool" },
	maxTurns: 4,
	needs: { structuredOutput: true, contextTokens: 128_000 },
});

const dataAnalyst = defineAgent(env, {
	name: "data_analysis",
	model: "analysis",
	prompt: dataAnalysisPrompt,
	input: Type.Object({ at: Type.String(), analysis_brief: Type.String(), resource_minutes: Type.Number() }),
	output: Type.Object({ evidence: Type.Array(Evidence) }),
	view: view(state, { fields: ["runs"], maxChars: 4000, maxItems: 4 }),
	writes: { evidence: "evidence" },
	tools: [runSkill],
	sandbox: "read-only",
	maxTurns: 24,
	needs: { structuredOutput: true, toolCalls: true },
});

const literature = defineAgent(env, {
	name: "literature_review",
	model: "literature",
	prompt: literaturePrompt,
	input: Type.Object({ at: Type.String(), bottlenecks: Type.Array(Type.String()), max_rounds: Type.Integer() }),
	output: Type.Object({ evidence: Type.Array(Evidence), search_rounds_used: Type.Integer() }),
	view: view(state, { fields: ["knowledge_cache"], maxChars: 6000, maxItems: 5 }),
	writes: { evidence: "evidence" },
	mcp: { arxiv: ["search_papers", "download_paper", "read_paper"], semantic_scholar: "*" },
	sandbox: "none",
	maxTurns: 32,
	needs: { structuredOutput: true, toolCalls: true },
});

const evidenceJudge = defineAgent(env, {
	name: "evidence_judge",
	model: "judge",
	prompt: evidenceJudgePrompt,
	input: Type.Object({ iteration: Type.Integer(), stop_criterion: Type.String() }),
	output: Type.Object({ brief: Type.String(), kept: Type.Array(Type.String()), stop: Type.Object({ recommend: Type.Boolean(), reason: Type.String() }) }),
	view: judgeProjection,
	maxTurns: 1,
	needs: { structuredOutput: true },
});

const proposer = defineAgent(env, {
	name: "propose",
	model: "propose",
	prompt: proposePrompt,
	input: Type.Object({
		iteration: Type.Integer(),
		task: Type.String(),
		evidence_brief: Type.String(),
		previous_failures: Type.Array(Type.String()),
		vram_budget_gb: Type.Number(),
	}),
	output: Proposal,
	view: proposerView,
	maxTurns: 6,
	needs: { structuredOutput: true, contextTokens: 128_000 },
});

const implementor = defineAgent(env, {
	name: "implement",
	model: "implement",
	prompt: implementPrompt,
	input: Type.Object({ proposal: Proposal, previous_validation_failure: Type.Union([Type.String(), Type.Null()]), probe_seed: Type.Integer() }),
	output: Type.Object({ model_file_path: Type.String(), config_path: Type.String(), capability_metadata: Type.Record(Type.String(), Type.String()) }),
	sandbox: "workspace",
	maxTurns: 40,
	needs: { structuredOutput: true, toolCalls: true },
});

const validator = defineAgent(env, {
	name: "validate",
	model: "validate",
	prompt: validatePrompt,
	input: Type.Object({ model_file_path: Type.String(), deterministic_report: validateScript.output }),
	output: Type.Object({ passed: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]), error_signatures: Type.Array(RawSignature) }),
	sandbox: "read-only",
	maxTurns: 4,
	needs: { structuredOutput: true },
});

const tunePlanner = defineAgent(env, {
	name: "tune_planner",
	model: "tune",
	prompt: tunePlannerPrompt,
	input: Type.Object({
		round: Type.Integer(),
		is_trial: Type.Boolean(),
		baseline_config: Config,
		best_trial_config: Type.Union([Config, Type.Null()]),
		notes: Type.Array(Type.String()),
		physical_rejections: Type.Array(Type.String()),
	}),
	output: Type.Object({ config: Config, rationale: Type.String() }),
	view: view(state, { fields: ["knowledge_cache"], maxChars: 6000, maxItems: 5 }),
	maxTurns: 2,
	needs: { structuredOutput: true },
});

/**
 * JudgeStop with `on_met: "request_input"`: presents the judge's
 * recommendation, ends its turn with the question (its node goes idle), and
 * submits the operator's decision once they reply.
 */
const stopCheck = defineAgent(env, {
	name: "stop_check",
	model: "judge",
	prompt: stopCheckPrompt,
	input: Type.Object({ iteration: Type.Integer(), criterion: Type.String(), recommendation: Type.String() }),
	output: Type.Object({ decision: Type.Union([Type.Literal("stop"), Type.Literal("continue")]), note: Type.String() }),
	maxTurns: 4,
	needs: { structuredOutput: true },
});

const tuneReflector = defineAgent(env, {
	name: "tune_reflector",
	model: "tune",
	prompt: tuneReflectorPrompt,
	input: Type.Object({ round: Type.Integer(), is_trial: Type.Boolean(), result: Type.Unknown() }),
	output: Type.Object({ notes: Type.String(), physical_rejections: Type.Array(Type.String()) }),
	maxTurns: 2,
	needs: { structuredOutput: true },
});

// --- Workflow input --------------------------------------------------------------

const Input = Type.Object({
	task: Type.String(),
	/** model_exploration.py: `for iteration in range(start, start + max_iterations)`. */
	maxIterations: Type.Integer({ minimum: 1 }),
	targetScore: Type.Union([Type.Number(), Type.Null()]),
	evidence: Type.Object({
		dataAnalysis: Type.Boolean(),
		literature: Type.Boolean(),
		/** SIDERIUS runs the two in sequence; `parallel` is the fan-out form. */
		order: Type.Union([Type.Literal("parallel"), Type.Literal("analysis_then_literature"), Type.Literal("literature_then_analysis")]),
		literatureMaxRounds: Type.Integer({ minimum: 1 }),
	}),
	/** Authored-loop stops (definition/models.py). Zero or empty turns them off. */
	stops: Type.Object({
		noImprovementBodies: Type.Integer({ minimum: 0 }),
		judgeCriterion: Type.String({ maxLength: 2000 }),
		/** JudgeStop `on_met`: stop at once, or ask the operator through the stop-check node. */
		judgeOnMet: Type.Union([Type.Literal("stop"), Type.Literal("request_input")]),
	}),
	maxProposalAttempts: Type.Integer({ minimum: 1 }),
	maxImplAttempts: Type.Integer({ minimum: 1 }),
	tuning: Type.Object({
		/** Rounds per candidate; the last is forced Formal, so Trial rounds need at least 2. */
		maxRounds: Type.Integer({ minimum: 1 }),
		maxFailRounds: Type.Integer({ minimum: 1 }),
		attemptsPerTrialRound: Type.Integer({ minimum: 1 }),
		attemptsPerFormalRound: Type.Integer({ minimum: 1 }),
		trialMinutes: Type.Number(),
		formalMinutes: Type.Number(),
		trialMaxEpochs: Type.Integer(),
		formalMaxEpochs: Type.Integer(),
		vramBudgetGb: Type.Number(),
	}),
});

type Input = Static<typeof Input>;
type Direction = Static<typeof Direction>;

const files = {
	dataScope: "siderius/data_scope.json",
	healthConfig: "siderius/health_config.yaml",
	advice: "siderius/advice.md",
};

// --- Helpers -----------------------------------------------------------------------

const tag = (iteration: number) => `iter-${String(iteration).padStart(3, "0")}`;

/** probe_seed_context(run_seed, iteration, attempt): deterministic per-attempt seeds. */
const probeSeed = (seed: number, iteration: number, attempt: number) => (seed * 1_000_003 + iteration * 1_009 + attempt) % 2_147_483_647;

function better(direction: Direction, a: number, b: number | null): boolean {
	if (b === null) return true;
	return direction === "higher_is_better" ? a > b : a < b;
}

function atLeast(direction: Direction, score: number, target: number): boolean {
	return direction === "higher_is_better" ? score >= target : score <= target;
}

// --- Deterministic folds: SIDERIUS's code, as body code -------------------------

type Finding = Static<typeof Finding>;
type CacheEntry = Static<typeof CacheEntry>;
type ErrorSignature = Static<typeof ErrorSignature>;
type CollapseEntry = Static<typeof CollapseEntry>;

/** LIST_FIELD_MAX_SURVIVORS */
const MAX_SURVIVORS = 8;
/** health_feedback_history_window_iterations and max_entries_per_model */
const COLLAPSE_WINDOW = 3;
const COLLAPSE_PER_MODEL = 8;

/** Rank-prune: strength, then number of evidence iterations, then latest iteration; overflow is archived. */
function rankPrune(items: readonly Finding[]): { kept: Finding[]; archived: Finding[] } {
	const latest = (f: Finding) => Math.max(-1, ...f.evidence_iters);
	const ranked = [...items].sort((a, b) => b.strength - a.strength || b.evidence_iters.length - a.evidence_iters.length || latest(b) - latest(a));
	return { kept: ranked.slice(0, MAX_SURVIVORS), archived: ranked.slice(MAX_SURVIVORS) };
}

/** _dedupe_error_signatures: one per (failure_class, top_user_frame, error_type); union evidence, keep the longer frames, the first message wins. */
function mergeSignatures(existing: readonly ErrorSignature[], incoming: readonly ErrorSignature[]): ErrorSignature[] {
	return dedupeBy(
		[...existing, ...incoming],
		(e) => JSON.stringify([e.failure_class, e.top_user_frame, e.error_type]),
		(kept, next) => ({
			...kept,
			evidence_iters: [...new Set([...kept.evidence_iters, ...next.evidence_iters])].sort((a, b) => a - b),
			last_frames: next.last_frames.length > kept.last_frames.length ? next.last_frames : kept.last_frames,
		}),
	);
}

/** Collapse history: drop entries outside the window, then keep the 8 most recent per model; empty models disappear. */
function pruneCollapse(history: Record<string, CollapseEntry[]>, fresh: readonly CollapseEntry[], iteration: number): Record<string, CollapseEntry[]> {
	const all = [...Object.values(history).flat(), ...fresh].filter((e) => e.iteration > iteration - COLLAPSE_WINDOW);
	return perKey(all, (e) => e.model_type, (entries) =>
		lastN(
			[...entries].sort((a, b) => a.iteration - b.iteration || a.count - b.count || a.signature.localeCompare(b.signature)),
			COLLAPSE_PER_MODEL,
		),
	);
}

/** cap_knowledge_cache: the current model plus the top 4 others by rank score; scoreless entries rank last. */
function capCache(cache: readonly CacheEntry[], current: CacheEntry): CacheEntry[] {
	const others = cache.filter((e) => e.model_type !== current.model_type);
	return [...topKBy(others, 4, (e) => e.rank_score, "descending"), current];
}

/**
 * prediction.py (metric_order_signsafe_v2): with distance = |actual - sota|
 * and band = 5% of |sota|, a missing score is unevaluated; better than SOTA
 * is confirmed (gain = distance); within the band is partial; else refuted.
 */
function evaluatePrediction(direction: Direction, actual: number | null, sota: number | null): { outcome: "confirmed" | "partial" | "refuted" | "unevaluated"; gain: number } {
	if (actual === null || sota === null) return { outcome: "unevaluated", gain: 0 };
	const distance = Math.abs(actual - sota);
	if (better(direction, actual, sota) && actual !== sota) return { outcome: "confirmed", gain: distance };
	if (distance <= 0.05 * Math.abs(sota)) return { outcome: "partial", gain: 0 };
	return { outcome: "refuted", gain: 0 };
}

// --- Sub-workflow: implement and validate, bounded retry --------------------------

const ImplementInput = Type.Object({
	proposal: Proposal,
	previous_failure: Type.Union([Type.String(), Type.Null()]),
	max_attempts: Type.Integer({ minimum: 1 }),
	seed: Type.Integer(),
	iteration: Type.Integer(),
});

const ImplementOutput = Type.Object({
	passed: Type.Boolean(),
	model_file_path: Type.Union([Type.String(), Type.Null()]),
	attempts: Type.Integer(),
	last_error: Type.Union([Type.String(), Type.Null()]),
	error_signatures: Type.Array(RawSignature),
});

const implementAndValidate = subWorkflow({
	name: "implement_validate",
	input: ImplementInput,
	output: ImplementOutput,
	run: async (ctx, input) => {
		let feedback = input.previous_failure;
		const signatures: Static<typeof RawSignature>[] = [];
		for (let attempt = 1; attempt <= input.max_attempts; attempt++) {
			const impl = await ctx.call(implementor, {
				proposal: input.proposal,
				previous_validation_failure: feedback,
				probe_seed: probeSeed(input.seed, input.iteration, attempt),
			});
			const report = await ctx.script(validateScript, { model_file_path: impl.model_file_path, probe_seed: probeSeed(input.seed, input.iteration, attempt) });
			const review = await ctx.call(validator, { model_file_path: impl.model_file_path, deterministic_report: report });
			signatures.push(...review.error_signatures);
			if (review.passed) {
				return { passed: true, model_file_path: impl.model_file_path, attempts: attempt, last_error: null, error_signatures: signatures };
			}
			feedback = review.error ?? "validation failed";
		}
		return { passed: false, model_file_path: null, attempts: input.max_attempts, last_error: feedback, error_signatures: signatures };
	},
});

// --- Sub-workflow: tuning, Trial rounds then a forced Formal round ------------------

const TuneInput = Type.Object({
	model_type: Type.String(),
	model_file_path: Type.String(),
	baseline_config: Config,
	iteration: Type.Integer(),
	seed: Type.Integer(),
	direction: Direction,
	max_rounds: Type.Integer(),
	max_fail_rounds: Type.Integer(),
	attempts_trial: Type.Integer(),
	attempts_formal: Type.Integer(),
	trial_minutes: Type.Number(),
	formal_minutes: Type.Number(),
	trial_max_epochs: Type.Integer(),
	formal_max_epochs: Type.Integer(),
	previous_rejections: Type.Array(Type.String()),
});

const TuneOutput = Type.Object({
	best_score: Score,
	best_formal_score: Score,
	best_valid_formal_score: Score,
	termination_reason: Type.String(),
	physical_rejections: Type.Array(Type.String()),
	failed_checks: Type.Array(HealthCheck),
});

const tune = subWorkflow({
	name: "tune",
	input: TuneInput,
	output: TuneOutput,
	run: async (ctx, input) => {
		let bestScore: number | null = null;
		let bestFormal: number | null = null;
		let bestValidFormal: number | null = null;
		let bestTrialConfig: Static<typeof Config> | null = null;
		let bestTrialScore: number | null = null;
		let failRounds = 0;
		const notes: string[] = [];
		const rejections = [...input.previous_rejections];
		const failedChecks: Static<typeof HealthCheck>[] = [];

		for (let round = 1; round <= input.max_rounds; round++) {
			// force_formal_round: the last round is Formal (formal_round_strategy full_clone).
			const isTrial = round < input.max_rounds;
			const plan: Static<typeof tunePlanner.output> = await ctx.call(tunePlanner, {
				round,
				is_trial: isTrial,
				baseline_config: input.baseline_config,
				best_trial_config: bestTrialConfig,
				notes,
				physical_rejections: rejections,
			});
			const config: Static<typeof Config> = isTrial ? plan.config : { ...(bestTrialConfig ?? plan.config), ...plan.config };

			// Gate refusals and OOM count as attempts, not rounds.
			let scored: { score: number; checkpoint: string } | null = null;
			const attempts = isTrial ? input.attempts_trial : input.attempts_formal;
			const scope = isTrial ? "trial" : "formal";
			for (let attempt = 1; attempt <= attempts && scored === null; attempt++) {
				const trained = await ctx.script(trainScript, {
					config,
					scope,
					max_epochs: isTrial ? input.trial_max_epochs : input.formal_max_epochs,
					time_budget_minutes: isTrial ? input.trial_minutes : input.formal_minutes,
					seed: probeSeed(input.seed, input.iteration * 100 + round, attempt),
					data_scope: files.dataScope,
				});
				if (trained.status === "infrastructure_abort") {
					return {
						best_score: bestScore,
						best_formal_score: bestFormal,
						best_valid_formal_score: bestValidFormal,
						termination_reason: "infrastructure_abort",
						physical_rejections: rejections,
						failed_checks: failedChecks,
					};
				}
				if (trained.status !== "ok" || trained.checkpoint === null) continue;
				const evaluated = await ctx.script(evaluateScript, { checkpoint: trained.checkpoint, scope });
				if (evaluated.scoreable && evaluated.score !== null) scored = { score: evaluated.score, checkpoint: trained.checkpoint };
			}

			if (scored === null) {
				failRounds++;
				if (failRounds >= input.max_fail_rounds) break;
				continue;
			}
			failRounds = 0;

			// Health: scientific gates on every scored round.
			const health = await ctx.script(healthScript, { checkpoint: scored.checkpoint, health_config: files.healthConfig, model_type: input.model_type });
			failedChecks.push(...health.failed_checks);
			if (better(input.direction, scored.score, bestScore)) bestScore = scored.score;
			if (isTrial && better(input.direction, scored.score, bestTrialScore)) {
				bestTrialScore = scored.score;
				bestTrialConfig = config;
			}
			if (!isTrial) {
				if (better(input.direction, scored.score, bestFormal)) bestFormal = scored.score;
				if (health.valid && better(input.direction, scored.score, bestValidFormal)) bestValidFormal = scored.score;
			}

			const reflection = await ctx.call(tuneReflector, { round, is_trial: isTrial, result: { score: scored.score, health } });
			notes.push(reflection.notes);
			rejections.push(...reflection.physical_rejections);
		}

		return {
			best_score: bestScore,
			best_formal_score: bestFormal,
			best_valid_formal_score: bestValidFormal,
			termination_reason: failRounds >= input.max_fail_rounds ? "aborted_fail_rounds" : "completed",
			physical_rejections: rejections,
			failed_checks: failedChecks,
		};
	},
});

// --- The loop ------------------------------------------------------------------------

type StopReason =
	| "target_reached"
	| "infrastructure_abort"
	| "iterations_exhausted"
	| "no_improvement"
	| "judge_stop"
	| "operator_stop";

export default workflow({
	name: "siderius",
	models,
	state,
	mcp,
	agents: [interpreter, dataAnalyst, literature, evidenceJudge, stopCheck, proposer, implementor, validator, tunePlanner, tuneReflector, consolidator],
	scripts: [trainScript, evaluateScript, healthScript, fingerprintScript, metricOrderScript, validateScript, runSkillScript],
	// LLM spend is new in wallis (SIDERIUS only logs tokens). A spent budget
	// pauses the run, which `wallis resume --budget usd=...` continues;
	// compute minutes reach every script as its remaining budget.
	budget: { usd: 40, turns: 3000, computeMinutes: 24 * 60 },
	// run_invariants.py: resolved_data_scope, health_config_sha256 and
	// advice_sha256. The seed, workflow digest and resolved alias table are
	// always pinned.
	pin: { files: [files.dataScope, files.healthConfig, files.advice] },
	input: Input,
	output: Type.Object({
		stop_reason: Type.String(),
		iterations: Type.Integer(),
		incumbent: Type.Union([Incumbent, Type.Null()]),
	}),
	run: async (ctx, input: Input) => {
		const { direction } = await ctx.script(metricOrderScript, { data_scope: files.dataScope });
		const sign = direction === "higher_is_better" ? 1 : -1;

		let stop: StopReason = "iterations_exhausted";
		let iterations = 0;
		let lastRejections: string[] = [];
		let bodiesWithoutImprovement = 0;

		// Unbounded reads for the body's own folds (not an agent view).
		const whole = view(state, { fields: ["knowledge_cache", "collapse_history"], maxChars: 10_000_000, maxItems: 10_000 });
		const readCache = async () => (await ctx.read(whole)).data.knowledge_cache ?? [];
		const incumbent = async () => (await ctx.read(view(state, { fields: ["incumbent"], maxChars: 1000, maxItems: 1 }))).data.incumbent[0] ?? null;

		for (let iteration = 0; iteration < input.maxIterations; iteration++) {
			// 1. Target check against the Health-valid formal incumbent.
			const best = await incumbent();
			if (input.targetScore !== null && best !== null && atLeast(direction, best.score, input.targetScore)) {
				stop = "target_reached";
				break;
			}
			iterations++;

			// 2. Interpretation of the previous iteration (cold start on the first).
			const interpretation = await ctx.call(interpreter, { iteration, cold_start: iteration === 0, metric_direction: direction });

			// 2b. Consolidate the findings into each model's own cache entry
			// (cache_consolidator: at most one call per list, on a cache hit).
			let cache = await readCache();
			for (const [modelType, found] of Object.entries(perKey(interpretation.key_findings, (f) => f.model_type))) {
				const entry = cache.find((e) => e.model_type === modelType);
				if (!entry) {
					// A cache miss: nothing to consolidate into.
					for (const f of found) await ctx.emit("findings_archive", f);
					continue;
				}
				const updated: CacheEntry = { ...entry };
				for (const kind of ["finding", "bottleneck"] as const) {
					const incoming = found.filter((f) => f.kind === kind);
					if (incoming.length === 0) continue;
					const list = kind === "finding" ? "key_findings" : "bottlenecks";
					const merged = await ctx.call(consolidator, { model_type: modelType, kind, current: entry[list], incoming, max: MAX_SURVIVORS });
					const pruned = rankPrune(merged.items);
					updated[list] = pruned.kept;
					for (const f of [...merged.archived, ...pruned.archived]) await ctx.emit("findings_archive", f);
				}
				cache = cache.map((e) => (e.model_type === modelType ? updated : e));
			}
			await ctx.emit("knowledge_cache", cache);

			// 3. Optional evidence stage, then the judge over a capped projection.
			let evidenceBrief = "";
			if (input.evidence.dataAnalysis || input.evidence.literature) {
				const at = tag(iteration);
				const bottlenecks = interpretation.key_findings.filter((f) => f.kind === "bottleneck").map((f) => f.statement);
				const analysis = () => ({ at, analysis_brief: interpretation.analysis_brief, resource_minutes: 30 });
				const lit = () => ({ at, bottlenecks, max_rounds: input.evidence.literatureMaxRounds });
				if (input.evidence.order === "parallel") {
					await ctx.parallel({
						analysis: async (c) => (input.evidence.dataAnalysis ? c.call(dataAnalyst, analysis()) : null),
						literature: async (c) => (input.evidence.literature ? c.call(literature, lit()) : null),
					});
				} else {
					const first = input.evidence.order === "analysis_then_literature" ? "analysis" : "literature";
					for (const node of first === "analysis" ? ["analysis", "literature"] : ["literature", "analysis"]) {
						if (node === "analysis" && input.evidence.dataAnalysis) await ctx.call(dataAnalyst, analysis());
						if (node === "literature" && input.evidence.literature) await ctx.call(literature, lit());
					}
				}
				const verdict = await ctx.call(evidenceJudge, { iteration, stop_criterion: input.stops.judgeCriterion });
				evidenceBrief = verdict.brief;
				if (input.stops.judgeCriterion !== "" && iteration > 0 && verdict.stop.recommend) {
					if (input.stops.judgeOnMet === "stop") {
						stop = "judge_stop";
						break;
					}
					// request_input: the stop-check node asks the operator and waits for the reply.
					const decision = await ctx.call(stopCheck, { iteration, criterion: input.stops.judgeCriterion, recommendation: verdict.stop.reason });
					if (decision.decision === "stop") {
						stop = "operator_stop";
						break;
					}
				}
			}

			// 4. Propose, then implement with a bounded validate/retry sub-workflow.
			const failures = [...lastRejections];
			const signatures: ErrorSignature[] = [];
			let candidate: { proposal: Static<typeof Proposal>; modelFile: string } | null = null;
			for (let attempt = 1; attempt <= input.maxProposalAttempts && candidate === null; attempt++) {
				try {
					const proposal = await ctx.call(proposer, {
						iteration,
						task: input.task,
						evidence_brief: evidenceBrief,
						previous_failures: failures,
						vram_budget_gb: input.tuning.vramBudgetGb,
					});
					const impl = await ctx.sub(implementAndValidate, {
						proposal,
						previous_failure: null,
						max_attempts: input.maxImplAttempts,
						seed: ctx.seed,
						iteration,
					});
					signatures.push(...impl.error_signatures.map((e) => ({ ...e, evidence_iters: [iteration] })));
					if (impl.passed && impl.model_file_path !== null) candidate = { proposal, modelFile: impl.model_file_path };
					else failures.push(impl.last_error ?? "validation failed");
				} catch (error) {
					if (!(error instanceof AgentFailed)) throw error;
					failures.push(`proposal attempt failed: ${error.message}`);
				}
			}

			if (candidate === null) {
				// Like SIDERIUS, a failed iteration still uses an iteration slot.
				await ctx.emit("runs", {
					iteration,
					model_type: "",
					status: "no_candidate",
					best_score: null,
					best_valid_formal_score: null,
					termination_reason: failures.at(-1) ?? "no candidate",
					take_home: interpretation.take_home,
				});
				continue;
			}

			// 5. Tuning: Trial rounds, then the forced Formal round, Health per round.
			const tuned = await ctx.sub(tune, {
				model_type: candidate.proposal.model_type,
				model_file_path: candidate.modelFile,
				baseline_config: candidate.proposal.baseline_config,
				iteration,
				seed: ctx.seed,
				direction,
				max_rounds: input.tuning.maxRounds,
				max_fail_rounds: input.tuning.maxFailRounds,
				attempts_trial: input.tuning.attemptsPerTrialRound,
				attempts_formal: input.tuning.attemptsPerFormalRound,
				trial_minutes: input.tuning.trialMinutes,
				formal_minutes: input.tuning.formalMinutes,
				trial_max_epochs: input.tuning.trialMaxEpochs,
				formal_max_epochs: input.tuning.formalMaxEpochs,
				previous_rejections: lastRejections,
			});
			lastRejections = tuned.physical_rejections.slice(-10);

			if (tuned.termination_reason === "infrastructure_abort") {
				// Evidence is kept, but the iteration is not folded into history.
				stop = "infrastructure_abort";
				break;
			}

			// 6. Health feedback: collapse fingerprints per model.
			const fingerprints = await ctx.script(fingerprintScript, { failed_checks: tuned.failed_checks, model_type: candidate.proposal.model_type, iteration });
			const history = (await ctx.read(whole)).data.collapse_history ?? {};
			await ctx.emit("collapse_history", pruneCollapse(history, fingerprints.entries, iteration));

			// 7. Fold the iteration into the carried history (advance_completed_history).
			const valid = tuned.best_valid_formal_score;
			await ctx.emit("runs", {
				iteration,
				model_type: candidate.proposal.model_type,
				status: "tuned",
				best_score: tuned.best_score,
				best_valid_formal_score: valid,
				termination_reason: tuned.termination_reason,
				take_home: interpretation.take_home,
			});
			const modelType = candidate.proposal.model_type;
			const cached = await readCache();
			const prior = cached.find((e) => e.model_type === modelType);
			const entry: CacheEntry = {
				model_type: modelType,
				description: candidate.proposal.model_description,
				iteration,
				rank_score: valid === null ? null : sign * valid,
				stats: { best_score: tuned.best_score, best_formal_score: tuned.best_formal_score, best_valid_formal_score: valid },
				key_findings: prior?.key_findings ?? [],
				bottlenecks: prior?.bottlenecks ?? [],
				error_signatures: mergeSignatures(prior?.error_signatures ?? [], signatures),
			};
			await ctx.emit("knowledge_cache", capCache(cached, entry));

			// PredictionMemory v2: the deterministic rule, against the incumbent before this iteration.
			const before = best === null ? null : best.score;
			const prediction = evaluatePrediction(direction, valid, before);
			if (prediction.outcome !== "unevaluated") {
				await ctx.emit("prediction_v2", prediction.outcome);
				await ctx.emit("info_gain_v2", prediction.gain);
			}
			if (valid !== null && better(direction, valid, before)) {
				await ctx.emit("incumbent", { rank_score: sign * valid, score: valid, model_type: candidate.proposal.model_type, iteration });
				bodiesWithoutImprovement = 0;
			} else {
				bodiesWithoutImprovement++;
			}

			// 8. Authored-loop stop: no strict incumbent improvement for N bodies.
			if (input.stops.noImprovementBodies > 0 && bodiesWithoutImprovement >= input.stops.noImprovementBodies) {
				stop = "no_improvement";
				break;
			}
		}

		// The target can be reached by the last iteration.
		const final = await incumbent();
		if (stop === "iterations_exhausted" && input.targetScore !== null && final !== null && atLeast(direction, final.score, input.targetScore)) {
			stop = "target_reached";
		}
		return { stop_reason: stop, iterations, incumbent: final };
	},
});
