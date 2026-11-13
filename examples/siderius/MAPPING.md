# SIDERIUS in wallis: the mapping

`workflow.ts` expresses the SIDERIUS research loop
(github.com/yuema137/SIDERIUS, commit 5ccb436) as a wallis workflow. The
mapping is approximate. The prompts, `trainer/` and `checks/` are
placeholders. The workflow runs end to end only with scripted agents and
commands (`test/siderius.test.ts`). Start with `README.md` for the tour.

Two ideas carry most of the mapping:

- **The carried history is local variables.** SIDERIUS's `ChainState`
  (knowledge cache, findings archive, collapse history, prediction memory,
  error signatures, incumbent) lives in the workflow body's local
  variables. A resume runs the body again from the top. Every call that
  finished is answered from the run's journal, so the variables come back
  as they were. SIDERIUS's `restore_prior_state` does the same job from its
  output files. Agents never read this state: the body builds each agent's
  typed input from it.
- **Visibility is per node.** `trainer/` (train, evaluate) and `checks/`
  (Health, fingerprints, the deterministic validator, the metric order) are
  bound only into the sandboxes of the commands that run them. `prompts/`
  is bound nowhere. So no agent or command can read the judge's prompt or
  the Health code it is graded by.

## Where this workflow and SIDERIUS differ

| Topic | SIDERIUS code | `workflow.ts` |
| --- | --- | --- |
| Evidence stage | `scientific_evidence_stage.py` runs data analysis and literature in sequence (default `analysis_then_literature`); the second node gets the first node's output. The fixed loop has no judge; judges exist only in authored loops (`judge_strategies/`). | Parallel by default; `input.evidence.order` selects either sequential order, but the second node does not get the first one's output. The judge is the authored-loop judge with its projection caps, run whenever the evidence stage runs. |
| Interpretation | Runs at the start of each iteration and covers the previous iteration's results. | The same: step 2 of each iteration. The last iteration's results are not interpreted. |
| Knowledge cache size | 5 entries: the current model plus the top 4 others. | The same (`capCache`). |
| Collapse history | Pruned: 3-iteration window, at most 8 entries per model, empty models dropped. | The same (`pruneCollapse`), but each fingerprint is its own entry (see 11 below). |
| Budgets | Wall time per Trial and Formal attempt, VRAM, epochs. LLM cost is not budgeted; tokens are logged. | The time and epoch caps are inputs to `train`; the trainer must enforce them. wallis's only budget is an agent call's `turns`. |

## Concept to construct

| SIDERIUS concept / file | wallis construct |
| --- | --- |
| `model_exploration.py::run_workflow` loop, `range(start, start + max_iterations)` | The default `workflow({ ... })`: a `for` loop over `input.maxIterations` |
| `ChainState` and `research_history.py` | Local variables of the body: `runs`, `knowledgeCache`, `findingsArchive`, `collapseHistory`, `predictionV1`/`predictionV2`/`infoGainV2`, `evidence`, `incumbent`, `lastRejections`. The run returns them as `carried`. |
| Target check before each iteration | `atLeast(direction, incumbent.score, target)` on the local `incumbent`, at the top of the loop and once after it |
| `ResultInterpretationAgent` (route `interpret`) | Agent `interpreter`. Its input carries `history` (runs, knowledge cache, collapse history) and `prediction_memory`. It reads `advice.md` from the `/config` bind (`workspace: { access: "read" }`). |
| `DataAnalysisAgent` and its skills | Agent `dataAnalyst` with `workspace: { access: "exec", sandbox: analysisBox }`: the `/data` bind (read-only) and a shell, in place of SIDERIUS's `run_skill` tool. Its input carries the last 4 run summaries. |
| `MLLiteratureReviewAgent`, Semantic Scholar and arXiv | Agent `literature`: no workspace, so no filesystem. `tools: [lit.searchArxiv, lit.searchScholar]` are custom tools in `tools/literature.ts` (read-only, `replay: "safe"`), run under node in `literatureBox` with the network. `S2_API_KEY` reaches only that process. |
| Judge strategies, projection caps (`judge-strategies-contract.md`) | Agent `evidenceJudge` (no mailbox, so nothing can message it mid-call). `judgeProjection` in body code: the newest 24 entries without self-reported confidence, oldest dropped until the JSON fits 4000 chars, with an `omitted` count. |
| `JudgeStop`, `on_met: "stop"` | `stops.judgeCriterion` plus the judge's `stop.recommend`, with `stops.judgeOnMet: "stop"` |
| `JudgeStop`, `on_met: "request_input"` | `stops.judgeOnMet: "request_input"`: the body sends `{ iteration, criterion, recommendation }` to the outbox `stop_check` and waits in its own mailbox, registered as `decision`, for `{ decision: "stop" \| "continue", note }`. The caller reads the question with `run.next()` and answers with `run.send("decision", …)`. An answer that does not match the schema is rejected (`MessageRejected`, `invalid`). |
| `NoImprovementStop` | `stops.noImprovementBodies` |
| `MLModelProposalAgent` (route `propose`), `max_proposal_attempts = 3` | Agent `proposer` in a loop of `input.maxProposalAttempts`, with `history` in its input and the `/config` bind. `previous_failures` collects validation errors, physical rejections and failed proposal calls (`NodeFailed`, caught). |
| `MLModelImplementor` and `MLCodeValidatorAgent`, `max_impl_attempts = 3` | Nested workflow `implementAndValidate`: agent `implementor` in `codingBox` (the data only, never `trainer/` or `checks/`), then command `validateScript` (checks 1–7 and 9), then agent `validator` (check 8, the LLM review) in `reviewBox`, which sees only its input plugin. Bounded; each failure is fed back. |
| A failed iteration still uses a slot | Pushes a `no_candidate` run summary, then `continue` |
| `HyperparamTuningAgent`, planner and reflector routes | Nested workflow `tune` with agents `tunePlanner` (the knowledge cache in its input) and `tuneReflector` |
| Trial rounds, `force_formal_round`, `formal_round_strategy = full_clone` | `isTrial = round < max_rounds`: the last round is Formal and inherits the best Trial config, overlaid by the planner's. |
| `attempts_per_round = 3`, `attempts_per_formal_round = 5`, `max_fail_rounds = 3` | `input.tuning.*`. OOM and gate refusals count as attempts. A Trial round's attempts run in parallel (`ctx.map`) and the round keeps its best scored attempt; Formal attempts run in sequence and stop at the first scored one. |
| Training, inference and `evaluate_metric` skills | Commands `trainScript` and `evaluateScript` in `trainerBox`: `./trainer` and `./data` bound read-only, typed JSON in and out. The Trial and Formal time and epoch caps are inputs. |
| Model plugin and checkpoints on disk (`iteration_NNN/attempt_NNN/impl_NNN/`) | Artifacts: the implementor returns the plugin (`ModelPlugin`, a file in its workspace), `trainScript` mounts it and returns a `Checkpoint`, which `evaluateScript` and `healthScript` mount. Nodes share no directories. |
| `resolved_data_scope` data files | The `./data` bind at `/data`, read-only |
| Health (`round_health.py`), effective Health config | Command `healthScript` in `checksBox`, run in parallel with `evaluateScript` on every trained checkpoint, reading `/config/health_config.yaml` |
| `best_denoising_score` vs `best_valid_formal_denoising_score` | `best_score` (unfiltered) vs `best_valid_formal_score` (Formal and Health-valid); only the latter drives the incumbent and the cache rank. |
| Collapse fingerprints, `collapse_fingerprint_history` | Command `fingerprintScript` (`checksBox`), then `pruneCollapse` on the local `collapseHistory` |
| `advance_completed_history` | Step 7 of the body: updates `runs`, `knowledgeCache` and `incumbent` |
| `cap_knowledge_cache` (keyed by `model_type`) | `capCache`: the current model plus the top 4 others by `rank_score`; ties keep insertion order, unscored last, as `MetricOrder.rank` does |
| `MetricOrder` / `reconcile_metric_spec` | Command `metricOrderScript` gives the direction once per run. `rank_score = sign × score`, so one descending order follows it. |
| `cache_consolidator` `list_merge` (at most 2 calls per model, at most 8 survivors, archive) | Per model, concurrently (`ctx.map`); on a cache hit, one `consolidator` call per list (`key_findings`, `bottlenecks`); `rankPrune` (strength, evidence count, latest iteration) keeps 8; overflow goes to `findingsArchive`. A cache miss is not consolidated. |
| `_dedupe_error_signatures` (no cap, inside each cache entry) | `mergeSignatures`: deduped on `(failure_class, top_user_frame, error_type)`, `evidence_iters` unioned, the longer `last_frames` kept, the first message wins; stored in the model's cache entry |
| `PredictionMemory`: v1 pool, v2 outcomes, v2 information gain | Locals `predictionV1` (the first pool the interpreter reports), `predictionV2` (outcome counts), `infoGainV2`. The v2 outcome comes from `evaluatePrediction`, the `prediction.py` rule. |
| `chain_formal_incumbent_reference` | The local `incumbent`, replaced on strict improvement |
| `run_invariants_lock.json` | The run's input (with its `seed`) is recorded when the run starts, and resume reuses it, so it cannot drift within a run. Each node's digest covers its own schemas, sandbox, prompt and functions; a changed node runs again on resume. The bound files (`/config`, `/data`, `trainer/`, `checks/`) are not digested: see 16 below. |
| `run_seed`, `probe_seed_context(run_seed, iteration, attempt)` | `input.seed` and `probeSeed(seed, iteration, attempt)`, used for the validator's probe seed and each training attempt's seed |
| `llm.json` routes | One model alias per route (`interpret`, `analysis`, `literature`, `judge`, `propose`, `implement`, `validate`, `tune`, `consolidate`), mapped in `.wallis/config.json`. An unmapped alias is an error, never a silent default. Each call journals the model that served it. |
| `token_usage.jsonl` | Not expressed. Each agent call's dialogue is kept (`run.transcript(callId)`), but wallis does no token accounting. |
| Chain-mode resume (`restore_prior_state`, a subprocess per iteration) | `resume()`: the body runs again; finished calls (matched on node, input and occurrence) come from the journal; calls in flight or failed run again as new attempts; an agent cut off mid-call continues from its last checkpointed turn. |
| `workflow_stop_reason`: `infrastructure_abort` > `target_reached` > `iterations_exhausted` | `StopReason`, plus `no_improvement`, `judge_stop` and `operator_stop` |
| Script outputs (train, evaluate, Health, fingerprints, metric order, validator) | `command`s with TypeBox inputs and outputs: input JSON on stdin, output JSON on stdout, checked against the schema. A mismatch fails the call (`NodeFailed`, `output_invalid`). |

## Not expressed, or approximated

### Loop and nodes

1. **Judge strategies.** One judge call replaces rubric-rank (repeats,
   median, exact `Fraction` weighted mean), debate, judge-merge and
   primary-advisors. Not expressed: `MAX_SCORED_ITEMS_PER_CALL`,
   `MAX_JUDGE_PROMPT_CHARS`, and the launch-time `max_judge_calls` check.
   SIDERIUS also removes `candidate_id`; the projection here has no ids to
   remove. The judge and the consolidator have `turns: 2`: an agent returns
   its output through a tool call, and a turn that ends without one costs a
   turn for a reminder. At the limit the call fails with
   `turn_limit_reached`.
2. **JudgeStop timing.** SIDERIUS consults the judge only after every
   deterministic stop condition said continue, and never at the final
   boundary. Here it is checked mid-iteration, after the evidence stage,
   from the second iteration on. There is no `on_failure` policy: a judge
   that fails throws `NodeFailed` in the body, which does not catch it, so
   the run fails and can be resumed.
3. **Interpretation.** SIDERIUS picks active models (top-K 3, last-N 2,
   |Δscore| ≥ 0.05), makes one LLM call per active model plus a synthesis
   call, and copies stable models. Here it is one call.
4. **Proposer.** The three stages (comparison, reasoning, proposing) are one
   call. The legacy two-call mode and the `validation_fixed_candidate_plan`
   bypass are not expressed.
5. **Validator.** The deterministic checks are one placeholder command. The
   bounded child process (at most 96 GiB of address space) and
   `validation_{run}.json` are not expressed.
6. **Tuner internals.** Not expressed: resource admission
   (`evaluate_vram_skill`, time forecasts), the pre-phase GPU measurement,
   the `hybrid_params` and `independent` Formal strategies, Trial-scoped
   `plan_overrides`, the bypass formal time budget. `full_clone` is
   approximated by merging the configs.
7. **Plugins.** Not expressed: staging, promotion to the global loss and
   model library, the capability registry. These are writes across runs; in
   wallis a run's files leave it only as output artifacts
   (`exportOutput`), and binds are read-only.
8. **Startup.** Not expressed: launch admission, hardware context, the
   runtime launch self-test, Step 0 seed tuning outputs (`source_paths`).

### Carried state

9. **Narrative cache fields.** Each cache entry holds its own findings,
   bottlenecks and error signatures. The six narrative fields
   (`best_config_analysis`, `score_trend`, …) are not expressed.
10. **Error signatures.** Deduped like `_dedupe_error_signatures` and kept
    per model, so they disappear when their model is evicted. The validator
    here reports them once per candidate.
11. **Collapse history.** Each fingerprint is its own entry. SIDERIUS merges
    occurrences of one signature (`occurrences[{iteration, count,
    source_exp_ids}]`).
12. **Metric order.** A command reports the direction once; a
    sign-normalized `rank_score` ranks in one direction. SIDERIUS's refusal
    to cap an unrankable cache (no MetricSpec) is not expressed.
13. **Prediction memory.** The v2 rule compares the iteration's best valid
    formal score with the incumbent before it. The v1 pool is the first one
    the interpreter reports.
14. **Other carried fields.** Not expressed: `vocab_link_confirmations`,
    `runtime_vocab`, `previous_proposal_data`, `recent_formal_feedback`,
    accumulated gate exhaustions. They would be more local variables.
15. **Prompt size.** Agents get their whole input as JSON. SIDERIUS renders
    fixed-size prompt sections; here only the judge's projection is capped.

### Invariants, compute, resources

16. **Run invariants.** SIDERIUS locks about 45 canonical fields and checks
    them on every restored output. Here the input is recorded and node
    definitions are digested, but bound files are not: after editing
    `advice.md`, `health_config.yaml`, the data or a script in `trainer/`
    or `checks/`, a resume still answers finished calls from the journal.
    Start a new run instead. Provenance fields are not expressed.
17. **Compute budgets.** SIDERIUS budgets wall time per attempt, VRAM,
    epochs and data portions. Here they are command inputs, and the trainer
    must enforce them; wallis kills nothing on time.
18. **GPU scheduling.** A Trial round's attempts start together; nothing
    limits how many share a GPU. Throttle them in code (batches or a small
    pool) for real training.
19. **Data-analysis policy.** The analyst sees `/data` read-only, its
    workspace and nothing else, with no network. SIDERIUS's anti-leakage
    policy (which files and columns an analysis may read), per-skill
    timeouts and memory envelopes are not expressed.
20. **Scheduling.** `scheduling_mode: parallel` and `host_budget` (parallel
    chains) are not expressed; the loop is serial.
21. **Telemetry.** No token rows or `[TOKEN_ITER]` rollup. `run.status()`
    and `run.tree()` show the calls, their attempts and their state.
22. **Infrastructure halt.** SIDERIUS writes a marker and exits with code 3.
    Here it is only the `infrastructure_abort` stop reason.
23. **Literature cache** (`cache/literature/root_papers`) is not expressed.
24. **The literature tools are a sketch.** `tools/literature.ts` calls the
    public arXiv and Semantic Scholar search APIs with minimal parsing; the
    tests do not call them.

### Limits of this example

25. `trainer/` and `checks/` hold placeholders that exit with an error; the
    test swaps in tiny scripted ones. A real trainer environment (`uv sync`)
    would live in a named volume prepared by a setup command.
26. Health runs on every trained checkpoint, in parallel with evaluation,
    and a Trial round's attempts all run: more compute than stopping at the
    first success.
27. The `/config` bind holds the advice and the Health config together, so
    `interpreter` and `proposer`, which read the advice, can also read the
    Health config file (not the Health code).
