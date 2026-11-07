# SIDERIUS in wallis

`workflow.ts` expresses the SIDERIUS research loop
(github.com/yuema137/SIDERIUS, commit 5ccb436) as a wallis workflow. The
mapping is approximate. The workflow type-checks, and it runs end to end
only with scripted agents and scripts (`host/test/siderius.test.ts`); the
prompts and `scripts/` are placeholders.

## Where the brief and SIDERIUS differ

The example follows the brief for wallis. Where the brief does not match
the SIDERIUS code, the code's behavior is noted here.

| Brief | SIDERIUS code | In `workflow.ts` |
| --- | --- | --- |
| Evidence stage as a fan-out, then a judge | `scientific_evidence_stage.py` runs data analysis and literature in sequence (default `analysis_then_literature`). The second node gets the first node's output. The fixed loop has no judge; judges exist only in authored loops (`judge_strategies/`). | `input.evidence.order` selects `parallel` (the fan-out) or either sequential order. The judge is the authored-loop judge with its projection caps. |
| Interpretation after Health | Interpretation runs at the start of each iteration and covers the previous iteration's results. | Same as SIDERIUS: it runs first in each iteration. The last iteration's results are not interpreted. |
| Knowledge cache: top 5 by metric plus the current model | 5 entries in total: the current model plus the top 4 others. | `capCache` in body code: the current model plus `topKBy(others, 4)`, 5 in total. |
| Collapse history never pruned | Pruned: 3-iteration window, at most 8 entries per model, empty models dropped. | Pruned as SIDERIUS does, in body code (`pruneCollapse`), written back with `replace`. (Round 3 owner decision; the first brief said never pruned.) |
| LLM USD budget | Not tracked or enforced; token use is only logged. | Added: `budget.usd` and `budget.turns`. A spent budget pauses the run (`Idle(BudgetExhausted)`); `wallis resume <run> --budget usd=…` continues it. |

## Concept to construct

| SIDERIUS concept / file | wallis construct |
| --- | --- |
| `model_exploration.py::run_workflow` loop, `range(start, start + max_iterations)` | `workflow({ run })`: a `for` loop over `input.maxIterations` |
| Target check before each iteration (2159) | `ctx.read` of `incumbent`, then `atLeast(direction, …)` |
| `ResultInterpretationAgent` (route `interpret`) | Agent `interpret` with `interpreterView`. It writes `findings`, `prediction_v1`, `prediction_v2` and `info_gain_v2`. |
| `DataAnalysisAgent`, authorized skills | Agent `data_analysis` with `defineTool(run_skill)` (served by `scripts/run_skill.py`) and `sandbox: "read-only"`. It writes `evidence`. |
| `MLLiteratureReviewAgent`, Semantic Scholar and arXiv | Agent `literature_review` with `mcp: { arxiv: [...], semantic_scholar: "*" }` over `mcp.json`. `S2_API_KEY` is a `${VAR}` secret reference. |
| Judge strategies, projection caps (`judge-strategies-contract.md`) | Agent `evidence_judge`. View `judgeProjection`: `maxChars 4000`, `maxItems 24`, `omit ["confidence", "candidate_id"]`, with omitted counts. |
| `JudgeStop` (authored loops), `on_met: "stop"` | `stops.judgeCriterion` plus `verdict.stop.recommend`, with `stops.judgeOnMet: "stop"` |
| `JudgeStop` `on_met: "request_input"` (pause and ask the operator) | `stops.judgeOnMet: "request_input"`: agent `stop_check` presents the recommendation and ends its turn with the question. Its node goes `Idle(question)`, and the operator's `send` continues the same conversation; it then submits `stop` or `continue`. |
| `NoImprovementStop` | `stops.noImprovementBodies` |
| `MLModelProposalAgent` (route `propose`), `max_proposal_attempts = 3` | Agent `propose` in a loop of `input.maxProposalAttempts`. `previous_failures` collects validation errors and physical rejections. |
| `MLModelImplementor` and `MLCodeValidatorAgent`, `max_impl_attempts = 3` | `subWorkflow(implement_validate)`: agent `implement` (`sandbox: "workspace"`), then script `validate` (checks 1–7 and 9), then agent `validate` (check 8, the LLM review). The loop is bounded and feeds failures back. |
| A failed iteration still uses a slot | Writes a `no_candidate` run summary, then `continue` |
| `HyperparamTuningAgent`, planner and reflector routes | `subWorkflow(tune)` with agents `tune_planner` and `tune_reflector` |
| Trial rounds, `force_formal_round`, `formal_round_strategy = full_clone` | `isTrial = round < maxRounds`. The Formal round inherits the best Trial config. |
| `attempts_per_round = 3`, `attempts_per_formal_round = 5`, `max_fail_rounds = 3` | `input.tuning.*`. OOM and gate refusals count as attempts. |
| Training, inference and `evaluate_metric` skills | Scripts `train` and `evaluate`. Trial and formal time and epoch caps are script arguments. |
| Model plugin and checkpoints on disk (`iteration_NNN/attempt_NNN/impl_NNN/`, plugin dirs) | Artifacts: the implementor exports the plugin (`ModelPlugin`), `train` mounts it with the dataset and returns a `Checkpoint` artifact, which `evaluate` and Health mount. Nodes share no directories. |
| `resolved_data_scope` data files | The dataset is mounted read-only from the local profile (`data.siderius_data`); its manifest digest is pinned next to `data_scope.json` |
| Health (`round_health.py`), effective Health config | Script `health` on every scored round. `siderius/health_config.yaml` is pinned. |
| `best_denoising_score` vs `best_valid_formal_denoising_score` | `best_score` (unfiltered) vs `best_valid_formal_score` (Formal and Health-valid); only the latter drives the incumbent and the cache rank. |
| Collapse fingerprints, `collapse_fingerprint_history` | Script `fingerprint`, then `pruneCollapse` (window 3, at most 8 per model) and `replace` |
| `advance_completed_history` (`research_history.py`) | Step 7 of the body: emits `runs`, `knowledge_cache` and `incumbent` |
| `cap_knowledge_cache` (keyed by `model_type`) | Per-model records in `knowledge_cache: replace(...)`; `capCache` keeps the current model plus `topKBy(others, 4, rank_score)`; ties keep insertion order, unscored last, as `MetricOrder.rank` does |
| `MetricOrder` / `reconcile_metric_spec` | Script `metric_order` gives the direction. `rank_score = sign × score`, so a static descending top-k follows it. |
| `cache_consolidator` `list_merge` (4 rules, at most 2 calls per model, at most 8 survivors, archive) | On a cache hit, one `ctx.call(consolidate_findings)` per model and list (`key_findings`, `bottlenecks`); `rankPrune` (strength, evidence count, latest iteration) keeps 8; overflow goes to `findings_archive`. A cache miss is not consolidated. |
| `_dedupe_error_signatures` (no cap, inside each cache entry) | `mergeSignatures` in body code: deduped on `(failure_class, top_user_frame, error_type)`, `evidence_iters` unioned, the longer `last_frames` kept, the first message wins; stored in the model's cache entry |
| `PredictionMemory`: v1 pool, v2 by semantics, v2 information gain, `prediction_evaluation_semantics` | `prediction_v1: freeze`, `prediction_v2: countByKey`, `info_gain_v2: sum`, `prediction_version: freeze(…, 2)`; the v2 outcome comes from `evaluatePrediction`, the `prediction.py` rule as body code |
| `chain_formal_incumbent_reference` | `incumbent: topK({ k: 1 })` |
| `run_invariants_lock.json`: `resolved_data_scope`, `health_config_sha256`, `advice_sha256`, `run_seed` | `pin.files`: `siderius/data_scope.json`, `siderius/health_config.yaml`, `siderius/advice.md`. The seed, workflow digest and alias table are pinned automatically. A mismatch on resume is refused and names the field. |
| Locked knobs (windows, policies, portions, evidence order …) | Constants in `workflow.ts` are covered by the workflow digest. Values in the run input are recorded in the log's `started` event and replayed on resume, so they cannot drift. |
| `run_seed`, `probe_seed_context(run_seed, iteration, attempt)`, `SeedCoordinates` | `ctx.seed` and `probeSeed()`. `Math.random` in the body is seeded from the pin. |
| `llm.json` routes (`interpret`, `data_analysis`, `lit_review.*`, `propose`, `implement`, `validate`, `tune.*`, `judge`, `cache_consolidator`) | `defineModels` alias table. Empty aliases resolve to `default`; callers remap aliases (as `openai-moderate-v1` does). |
| `token_usage.jsonl` | Per-call `usage` in `agent_returned` events of the wallis log |
| Trial/formal time budgets, compute | `budget.computeMinutes`. Every `RunScript` carries the remaining minutes. |
| Chain-mode resume (`restore_prior_state`, per-iteration subprocess) | wallis resume: refold the log, check the pin, replay the body. Completed calls and scripts are answered from the journal. |
| `workflow_stop_reason`: `infrastructure_abort` > `target_reached` > `iterations_exhausted` | `StopReason`, plus `no_improvement`, `judge_stop` and `operator_stop`. A spent budget is a pause, not a stop. |
| Script outputs (`train`, `evaluate`, Health, fingerprints, metric order, validator, skills) | `defineScript` with TypeBox input and output schemas. Args and outputs are checked in the sandbox and in the host; a mismatch is a typed `ScriptFailed`. |

## Not expressed, or approximated

These are the gaps between SIDERIUS and this workflow. Each one says why.

### Loop and nodes

1. **Judge strategies.** One judge call replaces rubric-rank (repeats, median,
   exact `Fraction` weighted mean), debate, judge-merge and primary-advisors.
   Not expressed: `MAX_SCORED_ITEMS_PER_CALL`, `MAX_JUDGE_PROMPT_CHARS`, and
   the launch-time `max_judge_calls` check against per-iteration bounds.
2. **JudgeStop timing.** SIDERIUS consults the judge only after every
   deterministic stop condition said continue, and never at the final
   boundary. Here it is checked mid-iteration, after the evidence stage.
   `on_met: "request_input"` is expressed (the `stop_check` node asks the
   operator), but there is no `on_failure` policy: a judge that fails is an
   agent failure in the body.
3. **Interpretation.** SIDERIUS picks active models (top-K 3, last-N 2,
   |Δscore| ≥ 0.05), makes one LLM call per active model plus a synthesis
   call, and copies stable models. Here it is one call.
4. **Proposer.** The three stages (comparison, reasoning, proposing) are one
   call. The legacy two-call mode and the `validation_fixed_candidate_plan`
   bypass are not expressed.
5. **Validator.** The deterministic checks are one placeholder script. The
   bounded child process (at most 96 GiB of address space) and
   `validation_{run}.json` are not expressed.
6. **Tuner internals.** Not expressed:
   - resource admission (`evaluate_vram_skill`, time forecast or measurement);
   - the pre-phase GPU measurement;
   - the `hybrid_params` and `independent` Formal strategies;
   - Trial-scoped `plan_overrides`;
   - the bypass formal time budget.

   Only `full_clone` is approximated, by merging the configs.
7. **Plugins.** Not expressed: staging, promotion to the global loss and model
   library, the capability registry and its cleanup. These are filesystem
   effects outside the run state.
8. **Startup.** Not expressed:
   - launch admission;
   - hardware context;
   - the runtime launch self-test;
   - Step 0 seed tuning outputs (`source_paths`), with `seed_summaries` and
     `validate_stamped_invariants` on each restored output.

### Carried state

9. **Narrative cache fields.** Each cache entry now holds its own findings,
   bottlenecks and error signatures, as in SIDERIUS. The six narrative
   fields (`best_config_analysis`, `score_trend`, …, kept as
   replace-with-history) are not expressed.
10. **Error signatures.** Deduped like `_dedupe_error_signatures` and kept
    per model, so like SIDERIUS they disappear when their model is evicted.
    Remaining difference: the validator emits them once per candidate, not
    once per frame.
11. **Collapse history.** Pruned like SIDERIUS (window and per-model cap), but
    each fingerprint is kept as its own entry. SIDERIUS merges occurrences of
    one signature (`occurrences[{iteration, count, source_exp_ids}]`).
12. **Metric order.** The direction is dynamic in SIDERIUS. Here a script
    reports it, and a sign-normalized `rank_score` lets `topKBy` rank in one
    direction. Not expressed: SIDERIUS refuses to cap an unrankable cache
    (no MetricSpec).
13. **Prediction memory.** The v2 rule is body code, comparing the
    iteration's best valid formal score with the incumbent before it.
    Remaining difference: SIDERIUS replaces all four fields on every body;
    here each has its own reducer, and the v1 pool comes from the
    interpreter.
14. **Other carried fields.** Not expressed: `vocab_link_confirmations`
    (promotion after 3 runs), `runtime_vocab`, `previous_proposal_data`,
    `recent_formal_feedback` (last 3), and accumulated gate exhaustions. The
    physical rejections (last 10) are a body variable; replay rebuilds it
    deterministically, but views cannot see it.

### Invariants, budgets, resources

15. **Run invariants.** About 45 canonical fields are locked in SIDERIUS.
    Only the data scope, Health config, advice file, seed and alias table are
    pinned explicitly; the rest are covered by the workflow digest or the
    recorded input. Not expressed: provenance fields (recorded, never
    compared), the legacy-lock refusals, and per-output stamp checks.
16. **Advice content.** The advice file is pinned, but the body cannot read
    files, so its text does not reach `interpret` or `propose` yet. It
    should be passed in the input or served by a tool.
17. **Compute budgets.** SIDERIUS budgets wall time per attempt (Trial and
    Formal), VRAM (`trial_vram_budget_gb`, `gpu_pair_ceiling_gib`), epochs
    and data portions. Here they are script arguments plus one run-level
    `computeMinutes` (a script is killed when it runs out). `train` and
    `evaluate` declare `resources` (GPU, memory) and wait for machine slots;
    VRAM is not measured.
18. **Resource envelope and access policy for data analysis.** Scripts run
    under bubblewrap and see only their input artifacts, the mounted dataset
    and their scratch dir. Not expressed: SIDERIUS's anti-leakage policy
    (which files and columns an analysis may read), per-skill timeouts,
    device and memory envelopes. The analysis agent's `read-only` level is
    enforced by the executor's tool layer.
19. **Scheduling.** `scheduling_mode: parallel` and `host_budget` (parallel
    chains in the candidate worker) are not expressed. The loop is serial.
20. **Telemetry.** SIDERIUS writes token rows labeled by node, iteration and
    character components, plus the `[TOKEN_ITER]` rollup. The wallis log
    keeps per-call usage only.
21. **Infrastructure halt.** SIDERIUS writes a marker and exits with code 3.
    Here it is only the `infrastructure_abort` stop reason.
22. **Literature cache** (`cache/literature/root_papers`) is not expressed.
23. **`mcp.json` pins are placeholders.** The server packages and versions
    were not checked against a registry.

### wallis prototype limits that affect this example

24. The host does not proxy MCP servers, serve `defineTool` tools, enforce
    sandboxes, or inject secrets. These are declared and carried to the
    executor, nothing more.
25. Only the fake executor exists, so the workflow has not met a real model.
26. Sub-workflows have no state of their own. `implement_validate` and
    `tune` return their outputs, and the main body folds them.
