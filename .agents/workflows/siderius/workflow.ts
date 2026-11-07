// SIDERIUS (github.com/yuema137/SIDERIUS, commit 5ccb436) as a wallis
// workflow: the fixed iteration loop of src/workflows/model_exploration.py
// with its carried history (research_history.py), run invariants and
// accounting. The task package (models, training, Health gates) stays
// domain code behind scripts/. See MAPPING.md for what maps where and what
// is approximated.
//
// The body is a pure program over journaled calls. The carried history
// (knowledge cache, findings archive, collapse history, prediction memory,
// error signatures, incumbent) is the body's local variables, rebuilt by
// replay on resume. Agents never read it: the body builds each agent's
// input from it, and marks the parts that can grow `Foldable`.

import {
	AgentFailed,
	Artifact,
	defineAgent,
	defineMcp,
	defineModels,
	command,
	defineMounts,
	defineSandbox,
	Foldable,
	type Ctx,
	type Static,
	subWorkflow,
	Type,
	workflow,
} from "wallis";
import mcpConfig from "./mcp.json" with { type: "json" };
import consolidatePrompt from "./prompts/consolidate-findings.md" with { type: "text" };
import dataAnalysisPrompt from "./prompts/data-analysis.md" with { type: "text" };
import evidenceJudgePrompt from "./prompts/evidence-judge.md" with { type: "text" };
import implementPrompt from "./prompts/implement.md" with { type: "text" };
import interpretPrompt from "./prompts/interpret.md" with { type: "text" };
import literaturePrompt from "./prompts/literature-review.md" with { type: "text" };
import proposePrompt from "./prompts/propose.md" with { type: "text" };
import stopCheckPrompt from "./prompts/stop-check.md" with { type: "text" };
import tunePlannerPrompt from "./prompts/tune-planner.md" with { type: "text" };
import tuneReflectorPrompt from "./prompts/tune-reflector.md" with { type: "text" };
import validatePrompt from "./prompts/validate.md" with { type: "text" };

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
	`,
);

const { Score, Config, RunSummary, Finding, RawSignature, ErrorSignature, CacheEntry, CollapseEntry, Evidence, Incumbent, Proposal, Scope, Direction, HealthCheck } = S;

// --- Artifacts, mounts and sandboxes ------------------------------------------------
//
// Files handed downstream are artifacts: the implementor exports the model
// plugin, train mounts it and returns the checkpoint, evaluate and Health
// mount the checkpoint.
//
// Nothing is implicit: the workflow dir is never mounted. Each sandbox sees
// only the mounts it names, read-only, plus its call's private scratch dir.
// `trainer/` and `checks/` are workflow-relative mounts; `prompts/` is
// never mounted anywhere, so no agent or command can read the judge's
// prompt or the Health code it is graded by. `data` (the dataset) and
// `config` (data_scope.json, health_config.yaml, advice.md: the locked
// files of run_invariants.py) are supplied by the caller or the local
// profile. Every mount's content digest is pinned.

const ModelPlugin = Artifact("text/x-python");
const Checkpoint = Artifact("application/x-checkpoint");
const mounts = defineMounts({ trainer: "./trainer", checks: "./checks", data: "", config: "" });

/** Files in the `config` mount, as the sandboxes see them. */
const files = {
	dataScope: "config/data_scope.json",
	healthConfig: "config/health_config.yaml",
	advice: "config/advice.md",
};

/** train and evaluate: the trainer's locked environment, built once by `uv sync`, then used offline. */
const trainerBox = defineSandbox(
	{ mounts },
	{
		name: "trainer",
		requires: ["uv", "sh"],
		setup: [["sh", "-c", 'UV_PROJECT_ENVIRONMENT="$WALLIS_ENV" uv sync --frozen --project trainer']],
		mounts: ["trainer", "data", "config"],
	},
);

/** The deterministic checks: Health, fingerprints, the validator, the metric order. */
const checksBox = defineSandbox({ mounts }, { name: "checks", requires: ["python3"], mounts: ["checks", "data", "config"] });

/** The implementor: the data only, never the trainer or the checks it is judged by. */
const codingBox = defineSandbox({ mounts }, { name: "coding", requires: ["bash", "python3"], mounts: ["data"] });

/** The data analyst: the data read-only and a shell (this replaces SIDERIUS's run_skill tool). */
const analysisBox = defineSandbox({ mounts }, { name: "analysis", requires: ["bash", "python3"], mounts: ["data"] });

/** Interpretation and proposal read the run's advice. */
const readingBox = defineSandbox({ mounts }, { name: "reading", requires: ["bash"], mounts: ["config"] });

/** The LLM validator reviews the plugin, an input artifact; it sees nothing else. */
const reviewBox = defineSandbox({ mounts }, { name: "review", requires: ["bash"] });

/** MCP servers run in their own sandboxes, each with its network allowlist. */
const arxivBox = defineSandbox({}, { name: "arxiv-mcp", requires: ["uvx"], network: ["arxiv.org", "export.arxiv.org", "pypi.org", "files.pythonhosted.org"] });
const scholarBox = defineSandbox({}, { name: "scholar-mcp", requires: ["uvx"], network: ["api.semanticscholar.org", "pypi.org", "files.pythonhosted.org"] });
const mcp = defineMcp(mcpConfig, { arxiv: { sandbox: arxivBox }, semantic_scholar: { sandbox: scholarBox } });

/** The default protocol: input JSON on stdin, output JSON (with artifact drafts) on stdout. */
const trainerRun = (script: string) => ["sh", "-c", `UV_PROJECT_ENVIRONMENT="$WALLIS_ENV" exec uv run --offline --no-sync --project trainer python trainer/${script}`] as const;

// --- Commands: the task package's domain code, as typed adapters ------------------

const trainScript = command({
	name: "train",
	description: "Train one candidate config on the trial or formal scope (training_skill).",
	sandbox: trainerBox,
	input: Type.Script({ ModelPlugin, Config, Scope, Int }, `{
		model: ModelPlugin, config: Config, scope: Scope, max_epochs: Int,
		time_budget_minutes: number, seed: Int, data_scope: string
	}`),
	output: Type.Script({ Checkpoint }, `{
		status: "ok" | "oom" | "gate_refused" | "infrastructure_abort",
		checkpoint: Checkpoint | null, minutes: number
	}`),
	run: trainerRun("train.py"),
	resources: { gpu: 1, memoryGb: 32 },
});

const evaluateScript = command({
	name: "evaluate",
	description: "Score a checkpoint on the trial or formal evaluation portion (inference_skill, evaluate_metric).",
	sandbox: trainerBox,
	input: Type.Script({ Checkpoint, Scope }, `{ checkpoint: Checkpoint, scope: Scope }`),
	output: Type.Script({ Score }, `{ scoreable: boolean, score: Score, metric_id: string }`),
	run: trainerRun("evaluate.py"),
	resources: { gpu: 1, memoryGb: 16 },
});

const healthScript = command({
	name: "health",
	description: "Run the scientific Health gates of the effective Health config (round_health.py).",
	sandbox: checksBox,
	input: Type.Script({ Checkpoint }, `{ checkpoint: Checkpoint, health_config: string, model_type: string }`),
	output: Type.Script({ HealthCheck }, `{ valid: boolean, policy: "blocking" | "recording", failed_checks: HealthCheck[] }`),
	run: ["python3", "checks/health.py"],
});

const fingerprintScript = command({
	name: "fingerprint",
	description: "Turn failed Health checks into collapse fingerprints.",
	sandbox: checksBox,
	input: Type.Script({ HealthCheck, Int }, `{ failed_checks: HealthCheck[], model_type: string, iteration: Int }`),
	output: Type.Script({ CollapseEntry }, `{ entries: CollapseEntry[] }`),
	run: ["python3", "checks/fingerprint.py"],
});

const metricOrderScript = command({
	name: "metric_order",
	description: "Reconcile the run's MetricSpec and report its direction (MetricOrder).",
	sandbox: checksBox,
	input: Type.Script(`{ data_scope: string }`),
	output: Type.Script({ Direction }, `{ metric_id: string, direction: Direction }`),
	run: ["python3", "checks/metric_order.py"],
});

const validateScript = command({
	name: "check_plugin",
	description: "Deterministic validator checks 1-7 and 9.",
	sandbox: checksBox,
	input: Type.Script({ ModelPlugin, Int }, `{ model: ModelPlugin, probe_seed: Int }`),
	output: Type.Script(`{ passed: boolean, error: string | null, checks: Record<string, boolean> }`),
	run: ["python3", "checks/validate.py"],
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
		// Codemode is always offered and costs a turn: 2 is the minimum.
		maxTurns: 2,
		needs: { structuredOutput: true },
	},
);

// --- Projections the body builds for agent inputs ---------------------------
//
// SIDERIUS's carried history lives in the body (see the loop). These are the
// shapes agents receive; the large ones are Foldable, so the prompt shows a
// skeleton when they outgrow maxChars and the full value is `input` in
// codemode.

type Evidence = Static<typeof Evidence>;
type Incumbent = Static<typeof Incumbent>;
type RunSummary = Static<typeof RunSummary>;

/** judge-strategies-contract.md: 4000 chars, 24 entries, no confidence or ids. */
const JUDGE_MAX_CHARS = 4000;
const JUDGE_MAX_ITEMS = 24;

const JudgedEvidence = Type.Object({ at: Type.String(), source: Type.String(), content: Type.String(), source_ref: Type.String() });

/**
 * The judge's evidence projection, built in code: the newest 24 entries,
 * without self-reported confidence, then the oldest dropped until the JSON
 * fits 4000 characters. `omitted` counts every entry left out.
 */
function judgeProjection(evidence: readonly Evidence[]): { items: Static<typeof JudgedEvidence>[]; omitted: number } {
	let items = evidence.slice(-JUDGE_MAX_ITEMS).map(({ at, source, content, source_ref }) => ({ at, source, content, source_ref }));
	while (items.length > 0 && JSON.stringify(items).length > JUDGE_MAX_CHARS) items = items.slice(1);
	return { items, omitted: evidence.length - items.length };
}

/** What the interpreter and proposer read: the carried history, foldable. */
const History = Type.Object({
	runs: Foldable(Type.Array(RunSummary), { maxChars: 6000 }),
	knowledge_cache: Foldable(Type.Array(CacheEntry), { maxChars: 12_000 }),
	collapse_history: Foldable(Type.Record(Type.String(), Type.Array(CollapseEntry)), { maxChars: 4000 }),
});

const PredictionMemory = Type.Object({
	version: Type.Integer(),
	v1: Type.Union([Type.Record(Type.String(), Type.Integer()), Type.Null()]),
	v2: Type.Record(Type.String(), Type.Integer()),
	info_gain_v2: Type.Number(),
});

// --- Agents: SIDERIUS nodes ----------------------------------------------------

const env = { models, mcp };

const interpreter = defineAgent(env, {
	name: "interpret",
	model: "interpret",
	prompt: interpretPrompt,
	input: Type.Object({
		iteration: Type.Integer(),
		cold_start: Type.Boolean(),
		metric_direction: Type.String(),
		history: History,
		prediction_memory: PredictionMemory,
	}),
	output: Type.Object({
		take_home: Type.String(),
		key_findings: Type.Array(Finding),
		legacy_prediction_pool: Type.Record(Type.String(), Type.Integer()),
		analysis_brief: Type.String(),
	}),
	// advice.md is read from the config mount.
	sandbox: readingBox,
	maxTurns: 4,
	needs: { structuredOutput: true, contextTokens: 128_000 },
});

const dataAnalyst = defineAgent(env, {
	name: "data_analysis",
	model: "analysis",
	prompt: dataAnalysisPrompt,
	input: Type.Object({ at: Type.String(), analysis_brief: Type.String(), resource_minutes: Type.Number(), recent_runs: Type.Array(RunSummary) }),
	output: Type.Object({ evidence: Type.Array(Evidence) }),
	sandbox: analysisBox,
	maxTurns: 24,
	needs: { structuredOutput: true, toolCalls: true },
});

const literature = defineAgent(env, {
	name: "literature_review",
	model: "literature",
	prompt: literaturePrompt,
	input: Type.Object({
		at: Type.String(),
		bottlenecks: Type.Array(Type.String()),
		max_rounds: Type.Integer(),
		knowledge_cache: Foldable(Type.Array(CacheEntry), { maxChars: 6000 }),
	}),
	output: Type.Object({ evidence: Type.Array(Evidence), search_rounds_used: Type.Integer() }),
	// MCP only: no sandbox, so no filesystem.
	mcp: { arxiv: ["search_papers", "download_paper", "read_paper"], semantic_scholar: "*" },
	maxTurns: 32,
	needs: { structuredOutput: true, toolCalls: true },
});

const evidenceJudge = defineAgent(env, {
	name: "evidence_judge",
	model: "judge",
	prompt: evidenceJudgePrompt,
	input: Type.Object({
		iteration: Type.Integer(),
		stop_criterion: Type.String(),
		evidence: Type.Array(JudgedEvidence, { maxItems: JUDGE_MAX_ITEMS }),
		omitted: Type.Integer(),
	}),
	output: Type.Object({ brief: Type.String(), kept: Type.Array(Type.String()), stop: Type.Object({ recommend: Type.Boolean(), reason: Type.String() }) }),
	// The judge is not steered: no answers, steering or interrupts; only cancel and a restart without a note.
	steerable: false,
	// Codemode is always offered and costs a turn: 2 is the minimum.
	maxTurns: 2,
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
		history: History,
	}),
	output: Proposal,
	sandbox: readingBox,
	maxTurns: 6,
	needs: { structuredOutput: true, contextTokens: 128_000 },
});

const implementor = defineAgent(env, {
	name: "implement",
	model: "implement",
	prompt: implementPrompt,
	input: Type.Object({ proposal: Proposal, previous_validation_failure: Type.Union([Type.String(), Type.Null()]), probe_seed: Type.Integer() }),
	// The plugin is exported from the node's scratch dir as an artifact.
	output: Type.Object({ model: ModelPlugin, capability_metadata: Type.Record(Type.String(), Type.String()) }),
	sandbox: codingBox,
	maxTurns: 40,
	needs: { structuredOutput: true, toolCalls: true },
});

const validator = defineAgent(env, {
	name: "validate",
	model: "validate",
	prompt: validatePrompt,
	input: Type.Object({ model: ModelPlugin, deterministic_report: validateScript.output }),
	output: Type.Object({ passed: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]), error_signatures: Type.Array(RawSignature) }),
	sandbox: reviewBox,
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
		knowledge_cache: Foldable(Type.Array(CacheEntry), { maxChars: 6000 }),
	}),
	output: Type.Object({ config: Config, rationale: Type.String() }),
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
		/** Default `parallel` (the two are independent). SIDERIUS runs them in sequence; either order is available. */
		order: Type.Optional(Type.Union([Type.Literal("parallel"), Type.Literal("analysis_then_literature"), Type.Literal("literature_then_analysis")])),
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
	const kept = new Map<string, ErrorSignature>();
	for (const e of [...existing, ...incoming]) {
		const key = JSON.stringify([e.failure_class, e.top_user_frame, e.error_type]);
		const prior = kept.get(key);
		kept.set(
			key,
			prior === undefined
				? e
				: {
						...prior,
						evidence_iters: [...new Set([...prior.evidence_iters, ...e.evidence_iters])].sort((a, b) => a - b),
						last_frames: e.last_frames.length > prior.last_frames.length ? e.last_frames : prior.last_frames,
					},
		);
	}
	return [...kept.values()];
}

/** Collapse history: drop entries outside the window, then keep the 8 most recent per model; empty models disappear. */
function pruneCollapse(history: Record<string, CollapseEntry[]>, fresh: readonly CollapseEntry[], iteration: number): Record<string, CollapseEntry[]> {
	const out: Record<string, CollapseEntry[]> = {};
	for (const e of [...Object.values(history).flat(), ...fresh]) {
		if (e.iteration <= iteration - COLLAPSE_WINDOW) continue;
		(out[e.model_type] ??= []).push(e);
	}
	for (const [model, entries] of Object.entries(out)) {
		out[model] = entries.sort((a, b) => a.iteration - b.iteration || a.count - b.count || a.signature.localeCompare(b.signature)).slice(-COLLAPSE_PER_MODEL);
	}
	return out;
}

/**
 * cap_knowledge_cache: the current model plus the top 4 others by rank
 * score; ties keep insertion order and scoreless entries rank last, as
 * MetricOrder.rank does.
 */
function capCache(cache: readonly CacheEntry[], current: CacheEntry): CacheEntry[] {
	const others = cache
		.filter((e) => e.model_type !== current.model_type)
		.map((e, i) => ({ e, i }))
		.sort((a, b) => (a.e.rank_score === null ? (b.e.rank_score === null ? a.i - b.i : 1) : b.e.rank_score === null ? -1 : b.e.rank_score - a.e.rank_score || a.i - b.i))
		.slice(0, 4)
		.map(({ e }) => e);
	return [...others, current];
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
	model: Type.Union([ModelPlugin, Type.Null()]),
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
			const report = await ctx.call(validateScript, { model: impl.model, probe_seed: probeSeed(input.seed, input.iteration, attempt) });
			const review = await ctx.call(validator, { model: impl.model, deterministic_report: report });
			signatures.push(...review.error_signatures);
			if (review.passed) {
				return { passed: true, model: impl.model, attempts: attempt, last_error: null, error_signatures: signatures };
			}
			feedback = review.error ?? "validation failed";
		}
		return { passed: false, model: null, attempts: input.max_attempts, last_error: feedback, error_signatures: signatures };
	},
});

// --- Sub-workflow: tuning, Trial rounds then a forced Formal round ------------------

const TuneInput = Type.Object({
	model_type: Type.String(),
	model: ModelPlugin,
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
	knowledge_cache: Type.Array(CacheEntry),
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
				knowledge_cache: input.knowledge_cache,
			});
			const config: Static<typeof Config> = isTrial ? plan.config : { ...(bestTrialConfig ?? plan.config), ...plan.config };

			// Gate refusals and OOM count as attempts, not rounds. Each attempt
			// trains, then scores and runs Health on its checkpoint in parallel.
			type Attempt = { status: string; scored: { score: number; checkpoint: Static<typeof Checkpoint>; health: Static<typeof healthScript.output> } | null };
			const attempts = isTrial ? input.attempts_trial : input.attempts_formal;
			const scope = isTrial ? "trial" : "formal";
			const tryOnce = async (c: Ctx, attempt: number): Promise<Attempt> => {
				const trained = await c.call(trainScript, {
					model: input.model,
					config,
					scope,
					max_epochs: isTrial ? input.trial_max_epochs : input.formal_max_epochs,
					time_budget_minutes: isTrial ? input.trial_minutes : input.formal_minutes,
					seed: probeSeed(input.seed, input.iteration * 100 + round, attempt),
					data_scope: files.dataScope,
				});
				if (trained.status !== "ok" || trained.checkpoint === null) return { status: trained.status, scored: null };
				const checkpoint = trained.checkpoint;
				const { evaluated, health } = await c.parallel({
					evaluated: (b) => b.call(evaluateScript, { checkpoint, scope }),
					health: (b) => b.call(healthScript, { checkpoint, health_config: files.healthConfig, model_type: input.model_type }),
				});
				return { status: "ok", scored: evaluated.scoreable && evaluated.score !== null ? { score: evaluated.score, checkpoint, health } : null };
			};
			// Trial attempts of one round run in parallel (resource slots throttle the GPUs);
			// Formal attempts stay sequential, stopping at the first scored one.
			const tried: Attempt[] = [];
			if (isTrial) tried.push(...(await ctx.map(Array.from({ length: attempts }, (_, i) => i + 1), (c, attempt) => tryOnce(c, attempt))));
			else for (let attempt = 1; attempt <= attempts && !tried.some((t) => t.scored); attempt++) tried.push(await ctx.parallel({ one: (c) => tryOnce(c, attempt) }).then((r) => r.one));
			if (tried.some((t) => t.status === "infrastructure_abort")) {
				return {
					best_score: bestScore,
					best_formal_score: bestFormal,
					best_valid_formal_score: bestValidFormal,
					termination_reason: "infrastructure_abort",
					physical_rejections: rejections,
					failed_checks: failedChecks,
				};
			}
			// The best scored attempt of the round, in attempt order on ties.
			const scored = tried
				.flatMap((t) => (t.scored ? [t.scored] : []))
				.reduce<Attempt["scored"]>((best, t) => (best === null || better(input.direction, t.score, best.score) ? t : best), null);

			if (scored === null) {
				failRounds++;
				if (failRounds >= input.max_fail_rounds) break;
				continue;
			}
			failRounds = 0;

			// Health: scientific gates on every scored round.
			const health = scored.health;
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
	mcp,
	mounts,
	agents: [interpreter, dataAnalyst, literature, evidenceJudge, stopCheck, proposer, implementor, validator, tunePlanner, tuneReflector, consolidator],
	commands: [trainScript, evaluateScript, healthScript, fingerprintScript, metricOrderScript, validateScript],
	// Attention points, not caps: agent turns and command compute minutes.
	// When one is reached no new call starts (calls in flight finish) and the
	// run waits for its owner: `wallis resume --budget turns=...`, or cancel.
	// USD and tokens are recorded for information only.
	budget: { turns: 3000, computeMinutes: 24 * 60 },
	// run_invariants.py: resolved_data_scope, health_config_sha256 and
	// advice_sha256 are the `config` mount's content digest, pinned with the
	// `data` mount's. The seed, workflow digest and resolved alias table are
	// always pinned.
	input: Input,
	output: Type.Object({
		stop_reason: Type.String(),
		iterations: Type.Integer(),
		incumbent: Type.Union([Incumbent, Type.Null()]),
		/** The carried history at the end of the run. */
		carried: Type.Object({
			runs: Type.Array(RunSummary),
			knowledge_cache: Type.Array(CacheEntry),
			findings_archive: Type.Array(Finding),
			collapse_history: Type.Record(Type.String(), Type.Array(CollapseEntry)),
			prediction: PredictionMemory,
		}),
	}),
	run: async (ctx, input: Input) => {
		const { direction } = await ctx.call(metricOrderScript, { data_scope: files.dataScope });
		const sign = direction === "higher_is_better" ? 1 : -1;

		// --- Run memory: SIDERIUS ChainState, as local variables -------------
		// recent_tune_outputs / latest_new_summary: one summary per iteration.
		const runs: RunSummary[] = [];
		// Per-model records (cap_knowledge_cache: the current model plus the top 4 others).
		let knowledgeCache: CacheEntry[] = [];
		// Findings dropped by consolidation or rank-pruning (cache_archive_*.json).
		const findingsArchive: Finding[] = [];
		// collapse_fingerprint_history keyed by model_type (3-iteration window, at most 8 per model).
		let collapseHistory: Record<string, CollapseEntry[]> = {};
		// PredictionMemory: the legacy v1 pool (first one wins), v2 outcome counts and gain.
		let predictionV1: Record<string, number> | null = null;
		const predictionV2: Record<string, number> = {};
		let infoGainV2 = 0;
		// Evidence for the judge projection, oldest first.
		const evidence: Evidence[] = [];
		// chain_formal_incumbent_reference.
		let incumbent: Incumbent | null = null;

		let stop: StopReason = "iterations_exhausted";
		let iterations = 0;
		let lastRejections: string[] = [];
		let bodiesWithoutImprovement = 0;
		const history = () => ({ runs, knowledge_cache: knowledgeCache, collapse_history: collapseHistory });

		for (let iteration = 0; iteration < input.maxIterations; iteration++) {
			// 1. Target check against the Health-valid formal incumbent.
			if (input.targetScore !== null && incumbent !== null && atLeast(direction, incumbent.score, input.targetScore)) {
				stop = "target_reached";
				break;
			}
			iterations++;
			ctx.observe("iteration", iteration);

			// 2. Interpretation of the previous iteration (cold start on the first).
			const interpretation: Static<typeof interpreter.output> = await ctx.call(interpreter, {
				iteration,
				cold_start: iteration === 0,
				metric_direction: direction,
				history: history(),
				prediction_memory: { version: 2, v1: predictionV1, v2: predictionV2, info_gain_v2: infoGainV2 },
			});
			predictionV1 ??= interpretation.legacy_prediction_pool;

			// 2b. Consolidate the findings into each model's own cache entry
			// (cache_consolidator: at most one call per list, on a cache hit).
			const byModel = new Map<string, Finding[]>();
			for (const f of interpretation.key_findings) byModel.set(f.model_type, [...(byModel.get(f.model_type) ?? []), f]);
			// Per model, concurrently (ctx.map: each model's branch has its own request ids).
			const consolidated = await ctx.map([...byModel], async (c, [modelType, found]) => {
				const entry = knowledgeCache.find((e) => e.model_type === modelType);
				// A cache miss: nothing to consolidate into.
				if (!entry) return { modelType, updated: null, archived: found };
				const updated: CacheEntry = { ...entry };
				const archived: Finding[] = [];
				for (const kind of ["finding", "bottleneck"] as const) {
					const incoming = found.filter((f) => f.kind === kind);
					if (incoming.length === 0) continue;
					const list = kind === "finding" ? "key_findings" : "bottlenecks";
					const merged = await c.call(consolidator, { model_type: modelType, kind, current: entry[list], incoming, max: MAX_SURVIVORS });
					const pruned = rankPrune(merged.items);
					updated[list] = pruned.kept;
					archived.push(...merged.archived, ...pruned.archived);
				}
				return { modelType, updated, archived };
			});
			for (const { modelType, updated, archived } of consolidated) {
				findingsArchive.push(...archived);
				if (updated) knowledgeCache = knowledgeCache.map((e) => (e.model_type === modelType ? updated : e));
			}

			// 3. Optional evidence stage, then the judge over its capped projection.
			let evidenceBrief = "";
			if (input.evidence.dataAnalysis || input.evidence.literature) {
				const at = tag(iteration);
				const bottlenecks = interpretation.key_findings.filter((f) => f.kind === "bottleneck").map((f) => f.statement);
				const analysis = () => ({ at, analysis_brief: interpretation.analysis_brief, resource_minutes: 30, recent_runs: runs.slice(-4) });
				const lit = () => ({ at, bottlenecks, max_rounds: input.evidence.literatureMaxRounds, knowledge_cache: knowledgeCache });
				const found: Evidence[] = [];
				const order = input.evidence.order ?? "parallel";
				if (order === "parallel") {
					const r = await ctx.parallel({
						analysis: async (c) => (input.evidence.dataAnalysis ? c.call(dataAnalyst, analysis()) : null),
						literature: async (c) => (input.evidence.literature ? c.call(literature, lit()) : null),
					});
					found.push(...(r.analysis?.evidence ?? []), ...(r.literature?.evidence ?? []));
				} else {
					for (const node of order === "analysis_then_literature" ? ["analysis", "literature"] : ["literature", "analysis"]) {
						if (node === "analysis" && input.evidence.dataAnalysis) found.push(...(await ctx.call(dataAnalyst, analysis())).evidence);
						if (node === "literature" && input.evidence.literature) found.push(...(await ctx.call(literature, lit())).evidence);
					}
				}
				evidence.push(...found);
				const projection = judgeProjection(evidence);
				const verdict = await ctx.call(evidenceJudge, { iteration, stop_criterion: input.stops.judgeCriterion, evidence: projection.items, omitted: projection.omitted });
				evidenceBrief = verdict.brief;
				if (input.stops.judgeCriterion !== "" && iteration > 0 && verdict.stop.recommend) {
					if (input.stops.judgeOnMet === "stop") {
						stop = "judge_stop";
						break;
					}
					// request_input: the stop-check node asks the operator and waits for the answer.
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
			let candidate: { proposal: Static<typeof Proposal>; model: Static<typeof ModelPlugin> } | null = null;
			for (let attempt = 1; attempt <= input.maxProposalAttempts && candidate === null; attempt++) {
				try {
					const proposal = await ctx.call(proposer, {
						iteration,
						task: input.task,
						evidence_brief: evidenceBrief,
						previous_failures: failures,
						vram_budget_gb: input.tuning.vramBudgetGb,
						history: history(),
					});
					const impl = await ctx.call(implementAndValidate, {
						proposal,
						previous_failure: null,
						max_attempts: input.maxImplAttempts,
						seed: ctx.seed,
						iteration,
					});
					signatures.push(...impl.error_signatures.map((e) => ({ ...e, evidence_iters: [iteration] })));
					if (impl.passed && impl.model !== null) candidate = { proposal, model: impl.model };
					else failures.push(impl.last_error ?? "validation failed");
				} catch (error) {
					if (!(error instanceof AgentFailed)) throw error;
					failures.push(`proposal attempt failed: ${error.message}`);
				}
			}

			if (candidate === null) {
				// Like SIDERIUS, a failed iteration still uses an iteration slot.
				runs.push({
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
			const tuned = await ctx.call(tune, {
				model_type: candidate.proposal.model_type,
				model: candidate.model,
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
				knowledge_cache: knowledgeCache,
			});
			lastRejections = tuned.physical_rejections.slice(-10);

			if (tuned.termination_reason === "infrastructure_abort") {
				// Evidence is kept, but the iteration is not folded into history.
				stop = "infrastructure_abort";
				break;
			}

			// 6. Health feedback: collapse fingerprints per model.
			const fingerprints = await ctx.call(fingerprintScript, { failed_checks: tuned.failed_checks, model_type: candidate.proposal.model_type, iteration });
			collapseHistory = pruneCollapse(collapseHistory, fingerprints.entries, iteration);

			// 7. Fold the iteration into the carried history (advance_completed_history).
			const valid = tuned.best_valid_formal_score;
			runs.push({
				iteration,
				model_type: candidate.proposal.model_type,
				status: "tuned",
				best_score: tuned.best_score,
				best_valid_formal_score: valid,
				termination_reason: tuned.termination_reason,
				take_home: interpretation.take_home,
			});
			const modelType = candidate.proposal.model_type;
			const prior = knowledgeCache.find((e) => e.model_type === modelType);
			knowledgeCache = capCache(knowledgeCache, {
				model_type: modelType,
				description: candidate.proposal.model_description,
				iteration,
				rank_score: valid === null ? null : sign * valid,
				stats: { best_score: tuned.best_score, best_formal_score: tuned.best_formal_score, best_valid_formal_score: valid },
				key_findings: prior?.key_findings ?? [],
				bottlenecks: prior?.bottlenecks ?? [],
				error_signatures: mergeSignatures(prior?.error_signatures ?? [], signatures),
			});

			// PredictionMemory v2: the deterministic rule, against the incumbent before this iteration.
			const before = incumbent === null ? null : incumbent.score;
			const prediction = evaluatePrediction(direction, valid, before);
			if (prediction.outcome !== "unevaluated") {
				predictionV2[prediction.outcome] = (predictionV2[prediction.outcome] ?? 0) + 1;
				infoGainV2 += prediction.gain;
			}
			if (valid !== null && better(direction, valid, before)) {
				incumbent = { rank_score: sign * valid, score: valid, model_type: modelType, iteration };
				ctx.observe("incumbent", incumbent);
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
		if (stop === "iterations_exhausted" && input.targetScore !== null && incumbent !== null && atLeast(direction, incumbent.score, input.targetScore)) {
			stop = "target_reached";
		}
		return {
			stop_reason: stop,
			iterations,
			incumbent,
			carried: { runs, knowledge_cache: knowledgeCache, findings_archive: findingsArchive, collapse_history: collapseHistory, prediction: { version: 2, v1: predictionV1, v2: predictionV2, info_gain_v2: infoGainV2 } },
		};
	},
});
