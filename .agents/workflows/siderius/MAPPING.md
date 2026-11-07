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
| Knowledge cache: top 5 by metric plus the current model | 5 entries in total: the current model plus the top 4 others. | `topK({ k: 4, keepLatest: true })`, 5 in total. |
| Collapse history never pruned | Pruned: 3-iteration window, at most 8 entries per model, empty models dropped. | Never pruned, as the brief asks. Views window it per model. |
| LLM USD budget | Not tracked or enforced; token use is only logged. | Added: `budget.usd` and `budget.turns`. |

## Concept to construct

| SIDERIUS concept / file | wallis construct |
| --- | --- |
| `model_exploration.py::run_workflow` loop, `range(start, start + max_iterations)` | `workflow({ run })`: a `for` loop over `input.maxIterations` |
| Target check before each iteration (2159) | `ctx.read` of `incumbent`, then `atLeast(direction, …)` |
| `ResultInterpretationAgent` (route `interpret`) | Agent `interpret` with `interpreterView`. It writes `findings`, `prediction_v1`, `prediction_v2` and `info_gain_v2`. |
| `DataAnalysisAgent`, authorized skills | Agent `data_analysis` with `defineTool(run_skill)` (served by `scripts/run_skill.py`) and `sandbox: "read-only"`. It writes `evidence`. |
| `MLLiteratureReviewAgent`, Semantic Scholar and arXiv | Agent `literature_review` with `mcp: { arxiv: [...], semantic_scholar: "*" }` over `mcp.json`. `S2_API_KEY` is a `${VAR}` secret reference. |
| Judge strategies, projection caps (`judge-strategies-contract.md`) | Agent `evidence_judge`. View `judgeProjection`: `maxChars 4000`, `maxItems 24`, `omit ["confidence", "candidate_id"]`, with omitted counts. |
| `JudgeStop` (authored loops) | `stops.judgeCriterion` plus `verdict.stop.recommend` |
| `NoImprovementStop` | `stops.noImprovementBodies` |
| `MLModelProposalAgent` (route `propose`), `max_proposal_attempts = 3` | Agent `propose` in a loop of `input.maxProposalAttempts`. `previous_failures` collects validation errors and physical rejections. |
| `MLModelImplementor` and `MLCodeValidatorAgent`, `max_impl_attempts = 3` | `subWorkflow(implement_validate)`: agent `implement` (`sandbox: "workspace"`), then script `validate` (checks 1–7 and 9), then agent `validate` (check 8, the LLM review). The loop is bounded and feeds failures back. |
| A failed iteration still uses a slot | Writes a `no_candidate` run summary, then `continue` |
| `HyperparamTuningAgent`, planner and reflector routes | `subWorkflow(tune)` with agents `tune_planner` and `tune_reflector` |
| Trial rounds, `force_formal_round`, `formal_round_strategy = full_clone` | `isTrial = round < maxRounds`. The Formal round inherits the best Trial config. |
| `attempts_per_round = 3`, `attempts_per_formal_round = 5`, `max_fail_rounds = 3` | `input.tuning.*`. OOM and gate refusals count as attempts. |
| Training, inference and `evaluate_metric` skills | Scripts `train` and `evaluate`. Trial and formal time and epoch caps are script arguments. |
| Health (`round_health.py`), effective Health config | Script `health` on every scored round. `siderius/health_config.yaml` is pinned. |
| `best_denoising_score` vs `best_valid_formal_denoising_score` | `best_score` (unfiltered) vs `best_valid_formal_score` (Formal and Health-valid); only the latter drives the incumbent and the cache rank. |
| Collapse fingerprints, `collapse_fingerprint_history` | Script `fingerprint`, then `ctx.emit("collapse_history", …)` into `appendByKey({ key: "model_type" })` |
| `advance_completed_history` (`research_history.py`) | Step 7 of the body: emits `runs`, `knowledge_cache` and `incumbent` |
| `cap_knowledge_cache` (keyed by `model_type`) | `topK({ k: 4, by: "rank_score", order: "descending", key: "model_type", keepLatest: true })` |
| `MetricOrder` / `reconcile_metric_spec` | Script `metric_order` gives the direction. `rank_score = sign × score`, so a static descending top-k follows it. |
| `cache_consolidator` `list_merge` (4 rules, at most 8 survivors, archive) | `llmMerge({ agent: consolidate_findings, max: 8, maxCalls: 60, archive: "findings_archive" })` |
| `_dedupe_error_signatures` (no cap, never pruned) | `union(ErrorSignature)` |
| `PredictionMemory`: v1 pool, v2 by semantics, v2 information gain, `prediction_evaluation_semantics` | `prediction_v1: freeze`, `prediction_v2: countByKey`, `info_gain_v2: sum`, `prediction_version: freeze(…, 2)` |
| `chain_formal_incumbent_reference` | `incumbent: topK({ k: 1 })` |
| `run_invariants_lock.json`: `resolved_data_scope`, `health_config_sha256`, `advice_sha256`, `run_seed` | `pin.files`: `siderius/data_scope.json`, `siderius/health_config.yaml`, `siderius/advice.md`. The seed, workflow digest and alias table are pinned automatically. A mismatch on resume is refused and names the field. |
| Locked knobs (windows, policies, portions, evidence order …) | Constants in `workflow.ts` are covered by the workflow digest. Values in the run input are recorded in the log's `started` event and replayed on resume, so they cannot drift. |
| `run_seed`, `probe_seed_context(run_seed, iteration, attempt)`, `SeedCoordinates` | `ctx.seed` and `probeSeed()`. `Math.random` in the body is seeded from the pin. |
| `llm.json` routes (`interpret`, `data_analysis`, `lit_review.*`, `propose`, `implement`, `validate`, `tune.*`, `judge`, `cache_consolidator`) | `defineModels` alias table. Empty aliases resolve to `default`; callers remap aliases (as `openai-moderate-v1` does). |
| `token_usage.jsonl` | Per-call `usage` in `agent_returned` events of the wallis log |
| Trial/formal time budgets, compute | `budget.computeMinutes`. Every `RunScript` carries the remaining minutes. |
| Chain-mode resume (`restore_prior_state`, per-iteration subprocess) | wallis resume: refold the log, check the pin, replay the body. Completed calls and scripts are answered from the journal. |
| `workflow_stop_reason`: `infrastructure_abort` > `target_reached` > `iterations_exhausted` | `StopReason`, plus `no_improvement`, `judge_stop` and `budget_exhausted` |

## Not expressed, or approximated

These are the gaps between SIDERIUS and this workflow. Each one says why.

### Loop and nodes

1. **Judge strategies.** One judge call replaces rubric-rank (repeats, median,
   exact `Fraction` weighted mean), debate, judge-merge and primary-advisors.
   Not expressed: `MAX_SCORED_ITEMS_PER_CALL`, `MAX_JUDGE_PROMPT_CHARS`, and
   the launch-time `max_judge_calls` check against per-iteration bounds.
2. **JudgeStop semantics.** SIDERIUS consults the judge only after every
   deterministic stop condition said continue, and never at the final
   boundary. Here it is checked mid-iteration, after the evidence stage.
   `on_met: "request_input"` (pause and ask the operator) and `on_failure`
   have no wallis equivalent: there is no human-input effect.
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

9. **Knowledge-cache entries are flat.** SIDERIUS consolidates per model: each
   cache entry has its own `key_findings` and `bottlenecks` (LLM-merged, at
   most 8) and six narrative fields kept as replace-with-history (`latest` up
   to 800 chars, 3 history entries). Here findings are merged once, globally,
   and the narrative fields are not expressed. Per-entry merging would need a
   keyed llmMerge (`llmMergeByKey`).
10. **Error-signature identity.** SIDERIUS dedupes on `(failure_class,
    top_user_frame, error_type)`, unions `evidence_iters` and keeps the
    longer `last_frames`. `union` dedupes whole values, so two messages for
    one key are kept as two items. In SIDERIUS the signatures live inside
    cache entries and disappear on eviction; here they are global.
11. **Collapse-history pruning.** See the table above: never pruned here.
    A pruning fold (window, top 8 per model) would need a pure script
    reducer. The design lists those, but the prototype does not implement
    them.
12. **Metric order.** The direction is dynamic in SIDERIUS. Here a script
    reports it, and a sign-normalized `rank_score` keeps `topK` static.
    Remaining differences:
    - Ties: `MetricOrder.rank` keeps insertion order; wallis breaks ties by
      canonical value.
    - SIDERIUS refuses to cap an unrankable cache (no MetricSpec). Not
      expressed.
13. **Prediction evaluation.** SIDERIUS computes `confirmed`/`partial`/
    `refuted` in code (5% band around SOTA, gain = distance). Here the
    interpreter agent reports the outcome and the gain. The rule could move
    into the body as deterministic TypeScript. SIDERIUS also replaces all four
    fields on every body; here each has its own reducer.
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
    `computeMinutes`. The prototype host has no real script sandbox, so
    nothing enforces them.
18. **Resource envelope and access policy for data analysis.** The
    anti-leakage policy, per-skill timeouts, device and memory are declared
    only as `sandbox: "read-only"` and a tool. Nothing enforces them.
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
