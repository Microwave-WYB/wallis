# SIDERIUS in wallis: the mapping

`workflow.ts` expresses the SIDERIUS research loop
(github.com/yuema137/SIDERIUS, commit 5ccb436) as a wallis workflow. The
mapping is approximate. The prompts, `trainer/` and `checks/` are
placeholders. The workflow runs end to end only with scripted agents and
commands (`test/siderius.test.ts`). Start with `README.md` for
the tour.

Claims about SIDERIUS cite its source at 5ccb436, as `file:function`, with
paths under `src/` unless they start with `configs/`. Score names follow
SIDERIUS (`best_denoising_score` is its primary metric, whatever the
task).

Two ideas carry most of the mapping:

- **The carried history is local variables.** SIDERIUS's `ChainState`
  (`core/chain_state.py:ChainState`: knowledge cache, accumulated findings,
  collapse history, prediction memory, incumbent, vocab, recent tune
  outputs) lives in the workflow body's local variables. A resume runs the
  body again from the top. Every call that finished is answered from the
  run's journal, so the variables come back as they were. SIDERIUS's
  `core/resume.py:restore_prior_state` does the same job from its output
  files. Agents never read this state: the body builds each agent's typed
  input from it.
- **Visibility is per node.** `trainer/` (train, evaluate) and `checks/`
  (Health, fingerprints, the deterministic validator, the metric order) are
  bound only into the sandboxes of the commands that run them. `prompts/`
  is bound nowhere. So no agent or command can read the judge's prompt or
  the Health code it is graded by.

## Where this workflow and SIDERIUS differ

| Topic | SIDERIUS code | `workflow.ts` |
| --- | --- | --- |
| Evidence stage | `workflows/scientific_evidence_stage.py` runs data analysis and literature in sequence (default `analysis_then_literature`, `workflows/run_config.py`); the second node gets the first node's output. Literature runs only with `lit_review_enabled` (default off). The fixed loop (`workflows/model_exploration.py:run_workflow`) has no judge; judges exist only in authored loops (`workflows/judge_strategies/`). | Parallel by default; `input.evidence.order` selects either sequential order, but the second node does not get the first one's output. Both are switched by `input.evidence`. The judge is the authored-loop judge with its projection caps, run whenever the evidence stage runs. |
| Interpretation | Runs at the start of each iteration and covers the previous iteration's results (`model_exploration.py:run_workflow`). | The same: step 2 of each iteration. The last iteration's results are not interpreted. |
| Budgets | Wall time per Trial and Formal attempt, VRAM, epochs. LLM cost is not budgeted; tokens are logged (`agent/llm_bridge.py:TokenUsageRow`). | The time and epoch caps are inputs to `train`; the trainer must enforce them. wallis's only budget is an agent call's `turns`. |

## Concept to construct

| SIDERIUS concept / file | wallis construct |
| --- | --- |
| `model_exploration.py:run_workflow`, `for iteration in range(start, start + max_iterations)` | The default `workflow({ ... })`: a `for` loop over `input.maxIterations` |
| `ChainState` and `workflows/research_history.py` | Local variables of the body: `runs`, `knowledgeCache`, `findingsArchive`, `collapseHistory`, `predictionV1`/`predictionV2`/`infoGainV2`, `evidence`, `incumbent`, `bestValidSoFar`, `lastRejections`. The run returns them as `carried`. |
| `workflows/termination.py:target_reached`, called before each iteration, against the Health-valid formal incumbent | `atLeast(direction, incumbent.score, target)` on the local `incumbent`, at the top of the loop and once after it |
| `ResultInterpretationAgent` (route `interpret`) | Agent `interpreter`. Its input carries `history` (runs, knowledge cache, collapse history) and `prediction_memory`. It reads `advice.md` from the `/config` bind (`workspace: { access: "read" }`). |
| `DataAnalysisAgent`: selects skills from caller-approved packs; the parent executes the resulting `AnalysisPlan` | Agent `dataAnalyst` with `workspace: { access: "exec", sandbox: analysisBox }`: it runs its own analysis in a shell over the `/data` bind (read-only). Its input carries the last 4 run summaries. |
| `MLLiteratureReviewAgent` (routes `lit_review.*`), Semantic Scholar and arXiv | Agent `literature`: no workspace, so no filesystem. `tools: [lit.searchArxiv, lit.searchScholar]` are custom tools in `tools/literature.ts` (read-only, `replay: "safe"`), run under node in `literatureBox` with the network. `S2_API_KEY` reaches only that process. |
| Judge projection (`judge_strategies/projection.py`: `MAX_PROJECTED_ENTRIES = 24`, `MAX_PROJECTED_CHARS = 4000` per projected field, an `omitted` count, no confidences or `candidate_id`) | Agent `evidenceJudge`. `judgeProjection` in body code: the newest 24 entries without self-reported confidence, oldest dropped until the whole JSON fits 4000 chars, with an `omitted` count. |
| `JudgeStop` (`workflows/definition/models.py`), `on_met: "stop"` | `stops.judgeCriterion` plus the judge's `stop.recommend`, with `stops.judgeOnMet: "stop"` |
| `JudgeStop`, `on_met: "request_input"` | `stops.judgeOnMet: "request_input"`: the body sends `{ iteration, criterion, recommendation }` to the outbox `stop_check` and waits in its own mailbox, registered as `decision`, for `{ decision: "stop" \| "continue", note }`. The caller reads the question with `run.next()` and answers with `run.send("decision", …)`. An answer that does not match the schema is rejected (`MessageRejected`, `invalid`). |
| `NoImprovementStop` (`definition/models.py`): consecutive bodies without strict incumbent improvement | `stops.noImprovementBodies` |
| `MLModelProposalAgent` (routes `propose.*`), `max_proposal_attempts = 3` (`run_config.py`) | Agent `proposer` in a loop of `input.maxProposalAttempts`, with `history` in its input and the `/config` bind. `previous_failures` starts with the last 10 physical rejections and collects validation errors and failed proposal calls (`NodeFailed`, caught). |
| `MLModelImplementor` and `MLCodeValidatorAgent`, `max_impl_attempts = 3` | Nested workflow `implementAndValidate`: agent `implementor` in `codingBox` (the data only, never `trainer/` or `checks/`), then command `validateScript` (SIDERIUS's checks 1–5 and the model probe, 6–7), then agent `validator` (check 8, the LLM review, blocking) in `reviewBox`, which sees only its input plugin. Bounded; each failure is fed back. |
| A failed iteration still uses a slot (`run_workflow`: `continue` after the proposal attempts) | Pushes a `no_candidate` run summary, then `continue` |
| `HyperparamTuningAgent` (routes `tune.planner`, `tune.reflector`) | Nested workflow `tune` with agents `tunePlanner` (the knowledge cache in its input) and `tuneReflector` |
| Rounds (`nodes/ml_hyperparameter_tune_agent/ml_hyperparameter_tune_agent.py`): only a successful round counts toward `max_rounds`; the last is Formal (`force_formal_round`); `formal_round_strategy = full_clone` | `while (completed < max_rounds)`; `isTrial = completed < max_rounds - 1`. A failed round is planned again until `max_fail_rounds` fail in a row. The Formal round starts from the best Health-valid Trial config, overlaid by the planner's. |
| `attempts_per_round = 3`, `attempts_per_formal_round = 5`, `max_fail_rounds = 3` (`run_config.py`) | `input.tuning.*`. Attempts run one after another and the round ends at the first scored one; OOM and gate refusals use an attempt. |
| Training, inference and `evaluate_metric` skills | Commands `trainScript` and `evaluateScript` in `trainerBox`: `./trainer` and `./data` bound read-only, typed JSON in and out. The Trial and Formal time and epoch caps are inputs. |
| Model plugin and checkpoints on disk (`iteration_NNN/attempt_NNN/impl_NNN/`) | Artifacts: the implementor returns the plugin (`ModelPlugin`, a file in its workspace), `trainScript` mounts it and returns a `Checkpoint`, which `evaluateScript` and `healthScript` mount. Nodes share no directories. |
| `resolved_data_scope` data files | The `./data` bind at `/data`, read-only |
| Health (`ml_hyperparameter_tune_agent/round_health.py:evaluate_round_health`): on each scored attempt, after scoring | Command `healthScript` in `checksBox`, after `evaluateScript`, on scored checkpoints only, reading `/config/health_config.yaml` |
| `best_denoising_score`, `best_valid_denoising_score`, `best_valid_formal_denoising_score` | `tune`'s `best_score` (unfiltered: ranks the knowledge cache), `best_valid_score` (Health-valid, Trial or Formal: the prediction reference) and `best_valid_formal_score` (drives the incumbent, the target and NoImprovementStop) |
| Collapse fingerprints (`agent/schemas/health_feedback.py`): 3-iteration window, at most 8 per model, empty models dropped | Command `fingerprintScript` (`checksBox`), then `pruneCollapse` on the local `collapseHistory` |
| `research_history.py:advance_completed_history` | Step 7 of the body: updates `runs`, `knowledgeCache`, the prediction memory and `incumbent`; only for an iteration that tuned a candidate |
| `research_history.py:cap_knowledge_cache` (keyed by `model_type`, ranked by `best_denoising_score`) | `capCache`: the current model plus the top 4 others by `rank_score` (the unfiltered best score); ties keep insertion order, unscored last, as `MetricOrder.rank` does |
| `MetricOrder` / `reconcile_metric_spec` | Command `metricOrderScript` gives the direction once per run. `rank_score = sign × score`, so one descending order follows it. |
| `agent/cache_consolidator.py` `list_merge` (at most 2 calls per model, at most 8 survivors, archive); it uses the interpret route | Per model, concurrently (`ctx.map`); on a cache hit, one `consolidator` call (alias `interpret`) per list (`key_findings`, `bottlenecks`); `rankPrune` (strength, evidence count, latest iteration) keeps 8; overflow goes to `findingsArchive`. A cache miss is not consolidated. |
| `cache_consolidator.py:_dedupe_error_signatures` (no cap, inside each cache entry) | `mergeSignatures`: deduped on `(failure_class, top_user_frame, error_type)`, `evidence_iters` unioned, the longer `last_frames` kept, the first message (at most 120 chars) wins; stored in the model's cache entry |
| `PredictionMemory`: v1 pool, v2 outcomes, v2 information gain; the rule in `nodes/result_interpretation_agent/prediction.py` | Locals `predictionV1` (the first pool the interpreter reports), `predictionV2` (outcome counts), `infoGainV2`. `evaluatePrediction` is the rule: the model's best score against the reference the proposer saw (`ml_model_proposal_agent/prediction_reference.py:observed_prediction_reference`, the best Health-valid score so far), here `bestValidSoFar`. |
| `chain_formal_incumbent_reference` | The local `incumbent`, replaced on strict improvement |
| `core/run_invariants.py` (about 48 locked fields) | The run's input (with its `seed`) is recorded when the run starts, and resume reuses it, so it cannot drift within a run. Each node's digest covers its own schemas, sandbox, prompt and functions; a changed node runs again on resume. The bound files (`/config`, `/data`, `trainer/`, `checks/`) are not digested: see 16 below. |
| `core/probe_seeds.py:probe_seed_context(run_seed, iteration, node_id, attempt)` | `input.seed` and `probeSeed(seed, iteration, attempt)`, for the validator's probe seed and each training attempt's seed. There is no `node_id` coordinate. |
| `configs/llm/default.json` routes (`interpret`, `data_analysis`, `lit_review.*`, `propose.*`, `implement`, `validate`, `tune.*`; `judge` an optional block) | One model alias per route family (`interpret`, `analysis`, `literature`, `judge`, `propose`, `implement`, `validate`, `tune`), mapped in `.wallis/config.json`. An unmapped alias is an error, never a silent default. Each call journals the model that served it. |
| `token_usage.jsonl` (`TokenUsageRow`), the `[TOKEN_ITER]` rollup | Not expressed. Each agent call's dialogue is kept (`run.transcript(callId)`), but wallis does no token accounting. |
| Chain-mode resume (`restore_prior_state`, a subprocess per iteration) | `resume()`: the body runs again; finished calls (matched on node, input and occurrence) come from the journal; calls in flight or failed run again as new attempts; an agent cut off mid-call continues from its last checkpointed turn. |
| `workflow_stop_reason` (`workflows/termination.py`): `infrastructure_abort` > `target_reached` > `iterations_exhausted` | `StopReason`, plus `no_improvement`, `judge_stop` and `operator_stop` |
| Script outputs (train, evaluate, Health, fingerprints, metric order, validator) | `command`s with TypeBox inputs and outputs: input JSON on stdin, output JSON on stdout, checked against the schema. A mismatch fails the call (`NodeFailed`, `output_invalid`). |

## Not expressed, or approximated

### Loop and nodes

1. **Judge strategies.** One judge call replaces rubric-rank (repeats,
   median, exact `Fraction` weighted mean), debate, judge-merge and
   primary-advisors (`judge_strategies/kinds.py`). Not expressed:
   `MAX_SCORED_ITEMS_PER_CALL = 16` and `MAX_JUDGE_PROMPT_CHARS = 400_000`
   (`agent/schemas/judge.py`), and the `max_judge_calls` cap
   (`workflows/llm_config.py`). The 4000-char cap applies here to the whole
   projection, in SIDERIUS to each projected field. The judge and the
   consolidator have `turns: 2`: an agent returns its output through a tool
   call, and a turn that ends without one costs a turn for a reminder.
2. **JudgeStop timing and policy.** SIDERIUS consults the judge only after
   every deterministic stop condition said continue, and never at the final
   boundary (`workflows/definition/definition-contract.md`). Here it is
   checked mid-iteration, after the evidence stage, from the second
   iteration on (SIDERIUS: `min_completed_bodies`). `on_failure` defaults
   to `"fail"` in SIDERIUS, as here: a judge that fails throws `NodeFailed`,
   the body does not catch it, and the run fails and can be resumed.
   `on_failure: "continue"` and `MetricThresholdStop` are not expressed.
3. **Interpretation.** SIDERIUS picks active models (top-K 3, last-N 2,
   |Δscore| ≥ 0.05) and calls the LLM per model only on a cache miss or
   when an active model has new rounds or a large enough score change
   (`nodes/interpretation_helpers.py:should_recall_per_model`); otherwise it
   reuses the cached entry. A synthesis call follows when there is more
   than one model. Here it is one call.
4. **Proposer.** The three stages (comparison, reasoning, proposing) are one
   call, without their internal retries. The legacy two-call mode and the
   fixed-candidate-plan bypass are not expressed.
5. **Validator.** The deterministic checks and the model probe are one
   placeholder command. Not expressed: the non-blocking inheritance check,
   the bounded child process for long probes
   (`agent/skills/validator_probe_worker.py`), and `validation_{run}.json`.
6. **Tuner internals.** Not expressed: resource admission and time
   forecasts, the pre-phase GPU measurement, the other Formal strategies
   (`hybrid_params`, `independent`, `inherit_best_trial`, `llm_propose`),
   the skip-formal gates (off by default), Health gate selection by round
   position, Trial-scoped `plan_overrides`. `full_clone` is approximated by
   merging the configs.
7. **Plugins.** Not expressed: construction admission, staging
   (`workflows/plugin_staging.py`), promotion to the global loss and model
   library, the capability registry (`core/capability_registry.py`). These
   are writes across runs; in wallis a run's files leave it only as output
   artifacts (`exportOutput`), and binds are read-only.
8. **Startup.** Not expressed: launch admission, hardware context, the
   runtime launch self-test, Step 0 seed tuning outputs.

### Carried state

9. **Narrative cache fields.** Each cache entry holds its own findings,
   bottlenecks and error signatures. The narrative fields
   (`best_config_analysis`, `score_trend`, …: the latest value plus the
   last 3) are not expressed.
10. **Error signatures.** Deduped like `_dedupe_error_signatures` and kept
    per model, so they disappear when their model is evicted. The validator
    here reports them once per candidate.
11. **Collapse history.** Each fingerprint is its own entry. SIDERIUS merges
    occurrences of one signature (`occurrences[{iteration, count,
    source_exp_ids}]`) and lets the latest observation overwrite its
    metrics.
12. **Metric order.** A command reports the direction once; a
    sign-normalized `rank_score` ranks in one direction. SIDERIUS's refusal
    to cap an over-full cache without a `MetricOrder` is not expressed.
13. **Prediction memory.** SIDERIUS evaluates a prediction in the next
    iteration's interpretation, so the last iteration's is never
    evaluated. Here it is evaluated when the iteration is folded in, from
    the same two values. The v1 pool is the first one the interpreter
    reports.
14. **Other carried fields.** Not expressed: `vocab_link_confirmations`,
    `runtime_vocab`, `previous_proposal_data`, `recent_formal_feedback`
    (the last 3), accumulated gate exhaustions. They would be more local
    variables.
15. **Prompt size.** Agents get their whole input as JSON. SIDERIUS renders
    fixed-size prompt sections; here only the judge's projection is capped.

### Invariants, compute, resources

16. **Run invariants.** SIDERIUS locks about 48 canonical fields and checks
    them on resume. Here the input is recorded and node definitions are
    digested, but bound files are not: after editing `advice.md`,
    `health_config.yaml`, the data or a script in `trainer/` or `checks/`,
    a resume still answers finished calls from the journal. Start a new run
    instead.
17. **Compute budgets.** SIDERIUS budgets wall time per attempt, VRAM,
    epochs and data portions. Here they are command inputs, and the trainer
    must enforce them; wallis kills nothing on time.
18. **Data-analysis policy.** The analyst sees `/data` read-only, its
    workspace and nothing else, with no network. SIDERIUS's `access_policy`
    (which files and columns an analysis may read), `per_skill_timeout_s`
    and the caller-approved skill packs are not expressed.
19. **Scheduling.** `scheduling_mode: "parallel-v1"` (parallel dispatch of
    graph units in authored bodies, under a host budget) is not expressed;
    the loop is serial.
20. **Telemetry.** No token rows or `[TOKEN_ITER]` rollup. `run.status()`
    and `run.tree()` show the calls, their attempts and their state.
21. **Halts.** SIDERIUS writes `.chain_halted` and exits with code 3 on an
    infrastructure abort, on the consecutive-failure brake
    (`--max_failed_iterations`, default 3, `workflows/run_one_iteration.py`)
    and on a run contract failure. Here an infrastructure abort is a stop
    reason; the brake is not expressed.
22. **Literature cache** (`cache/literature/root_papers`) is not expressed.
23. **The literature tools are a sketch.** `tools/literature.ts` calls the
    public arXiv and Semantic Scholar search APIs with minimal parsing; the
    tests do not call them.

### Limits of this example

24. `trainer/` and `checks/` hold placeholders that exit with an error; the test swaps in tiny scripted ones. A real trainer
    environment (`uv sync`) would live in a named volume prepared by a
    setup command.
25. The `/config` bind holds the advice and the Health config together, so
    `interpreter` and `proposer`, which read the advice, can also read the
    Health config file (not the Health code).
