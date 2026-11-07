# SIDERIUS in wallis

`workflow.ts` expresses the SIDERIUS research loop
(github.com/yuema137/SIDERIUS, commit 5ccb436) as a wallis workflow. The
mapping is approximate. The workflow type-checks, and it runs end to end
only with scripted agents and commands (`host/test/siderius.test.ts`); the
prompts, `trainer/` and `checks/` are placeholders.

Since round 5 the directory is laid out by who may see what: `trainer/`
(pyproject, lock, train, evaluate) and `checks/` (Health, fingerprints, the
deterministic validator, the metric order) are mounted only into the
sandboxes that run them, and `prompts/` is never mounted anywhere, so no
agent or command can read the judge's prompt or the Health code it is
graded by.

Since round 4 the body is a pure program over journaled calls. SIDERIUS's
carried history (`ChainState`: knowledge cache, findings archive, collapse
history, prediction memory, error signatures, incumbent) is the body's
local variables. A resume rebuilds them by replaying the body over the
journal, as SIDERIUS's `restore_prior_state` rebuilds them from its output
files. Agents never read it: the body builds each agent's input from it.

## Where the brief and SIDERIUS differ

The example follows the brief for wallis. Where the brief does not match
the SIDERIUS code, the code's behavior is noted here.

| Brief | SIDERIUS code | In `workflow.ts` |
| --- | --- | --- |
| Evidence stage as a fan-out, then a judge | `scientific_evidence_stage.py` runs data analysis and literature in sequence (default `analysis_then_literature`). The second node gets the first node's output. The fixed loop has no judge; judges exist only in authored loops (`judge_strategies/`). | Parallel by default (the two are independent); `input.evidence.order` selects either sequential order. The judge is the authored-loop judge with its projection caps. |
| Interpretation after Health | Interpretation runs at the start of each iteration and covers the previous iteration's results. | Same as SIDERIUS: it runs first in each iteration. The last iteration's results are not interpreted. |
| Knowledge cache: top 5 by metric plus the current model | 5 entries in total: the current model plus the top 4 others. | `capCache` in body code: the current model plus the top 4 others, 5 in total. |
| Collapse history never pruned | Pruned: 3-iteration window, at most 8 entries per model, empty models dropped. | Pruned as SIDERIUS does, in body code (`pruneCollapse`). (Round 3 owner decision; the first brief said never pruned.) |
| LLM USD budget | Not tracked or enforced; token use is only logged. | wallis budgets agent `turns` and command `computeMinutes` as attention points: when one is reached no new call starts, calls in flight finish, and the run waits (`Idle(BudgetReached)`) for `wallis resume <run> --budget turns=…` or a cancel. USD and tokens are recorded, never budgeted. |

## Concept to construct

| SIDERIUS concept / file | wallis construct |
| --- | --- |
| `model_exploration.py::run_workflow` loop, `range(start, start + max_iterations)` | `workflow({ run })`: a `for` loop over `input.maxIterations` |
| `ChainState` and `research_history.py` | Local variables of the body: `runs`, `knowledgeCache`, `findingsArchive`, `collapseHistory`, `predictionV1`/`predictionV2`/`infoGainV2`, `evidence`, `incumbent`, `lastRejections`. The run returns them as `carried`. |
| Target check before each iteration (2159) | `atLeast(direction, incumbent.score, target)` on the local `incumbent` |
| `ResultInterpretationAgent` (route `interpret`) | Agent `interpret`. Its input carries `history` (runs, knowledge cache, collapse history; each `Foldable`) and `prediction_memory`. It reads `advice.md` from the `config` mount (`sandbox: "read-only"`). |
| `DataAnalysisAgent`, authorized skills | Agent `data_analysis` with the `analysis` sandbox: the data mount read-only and a shell (`bash`), which replaces SIDERIUS's `run_skill` tool. Its input carries the last 4 run summaries. |
| `MLLiteratureReviewAgent`, Semantic Scholar and arXiv | Agent `literature_review`: MCP only, no sandbox (no filesystem). `mcp: { arxiv: [...], semantic_scholar: "*" }` over `mcp.json`; each server runs in its own sandbox from the overlay (`arxiv-mcp`, `scholar-mcp`) with its network allowlist. `S2_API_KEY` reaches only the Semantic Scholar server's process. The knowledge cache arrives `Foldable`. |
| Judge strategies, projection caps (`judge-strategies-contract.md`) | Agent `evidence_judge`, `steerable: false`. `judgeProjection` in body code: the newest 24 entries without self-reported confidence, oldest dropped until the JSON fits 4000 chars, with an `omitted` count. |
| `JudgeStop` (authored loops), `on_met: "stop"` | `stops.judgeCriterion` plus `verdict.stop.recommend`, with `stops.judgeOnMet: "stop"` |
| `JudgeStop` `on_met: "request_input"` (pause and ask the operator) | `stops.judgeOnMet: "request_input"`: agent `stop_check` presents the recommendation and ends its turn with the question. Its node goes `Idle(question)`, and the operator's answer continues the same dialogue; it then submits `stop` or `continue`. |
| `NoImprovementStop` | `stops.noImprovementBodies` |
| `MLModelProposalAgent` (route `propose`), `max_proposal_attempts = 3` | Agent `propose` in a loop of `input.maxProposalAttempts`, with `history` in its input and the `config` mount. `previous_failures` collects validation errors and physical rejections. |
| `MLModelImplementor` and `MLCodeValidatorAgent`, `max_impl_attempts = 3` | `subWorkflow(implement_validate)`: agent `implement` in the `coding` sandbox (the data only, never `trainer/` or `checks/`), then command `check_plugin` (checks 1–7 and 9), then agent `validate` (check 8, the LLM review) in the `review` sandbox (its input artifact only). The loop is bounded and feeds failures back. |
| A failed iteration still uses a slot | Pushes a `no_candidate` run summary, then `continue` |
| `HyperparamTuningAgent`, planner and reflector routes | `subWorkflow(tune)` with agents `tune_planner` (the knowledge cache in its input, `Foldable`) and `tune_reflector` |
| Trial rounds, `force_formal_round`, `formal_round_strategy = full_clone` | `isTrial = round < maxRounds`. The Formal round inherits the best Trial config. |
| `attempts_per_round = 3`, `attempts_per_formal_round = 5`, `max_fail_rounds = 3` | `input.tuning.*`. OOM and gate refusals count as attempts. The Trial attempts of one round run in parallel (`ctx.map`; resource slots throttle the GPUs) and the round keeps its best scored attempt; Formal attempts stay sequential. |
| Training, inference and `evaluate_metric` skills | Commands `train` and `evaluate` in the `trainer` sandbox: `uv` and `sh` required, `trainer/` and the data mounted, the env built once by `uv sync --frozen` (setup, cached by digest) and used offline. Trial and formal time and epoch caps are inputs. |
| Model plugin and checkpoints on disk (`iteration_NNN/attempt_NNN/impl_NNN/`, plugin dirs) | Artifacts: the implementor exports the plugin (`ModelPlugin`), `train` mounts it with the dataset and returns a `Checkpoint` artifact, which `evaluate` and Health mount. Nodes share no directories. |
| `resolved_data_scope` data files | Mount `data` (read-only, supplied by the caller or the local profile); its content digest is pinned |
| Health (`round_health.py`), effective Health config | Command `health` in the `checks` sandbox, run in parallel with `evaluate` on every trained checkpoint, reading `config/health_config.yaml`. |
| `best_denoising_score` vs `best_valid_formal_denoising_score` | `best_score` (unfiltered) vs `best_valid_formal_score` (Formal and Health-valid); only the latter drives the incumbent and the cache rank. |
| Collapse fingerprints, `collapse_fingerprint_history` | Command `fingerprint` (checks sandbox), then `pruneCollapse` (window 3, at most 8 per model) on the local `collapseHistory` |
| `advance_completed_history` (`research_history.py`) | Step 7 of the body: updates `runs`, `knowledgeCache` and `incumbent` |
| `cap_knowledge_cache` (keyed by `model_type`) | `capCache`: the current model plus the top 4 others by `rank_score`; ties keep insertion order, unscored last, as `MetricOrder.rank` does |
| `MetricOrder` / `reconcile_metric_spec` | Command `metric_order` (checks sandbox) gives the direction. `rank_score = sign × score`, so one descending order follows it. |
| `cache_consolidator` `list_merge` (4 rules, at most 2 calls per model, at most 8 survivors, archive) | Per model concurrently (`ctx.map`); on a cache hit, one `ctx.call(consolidate_findings)` per list (`key_findings`, `bottlenecks`); `rankPrune` (strength, evidence count, latest iteration) keeps 8; overflow goes to `findingsArchive`. A cache miss is not consolidated. |
| `_dedupe_error_signatures` (no cap, inside each cache entry) | `mergeSignatures`: deduped on `(failure_class, top_user_frame, error_type)`, `evidence_iters` unioned, the longer `last_frames` kept, the first message wins; stored in the model's cache entry |
| `PredictionMemory`: v1 pool, v2 by semantics, v2 information gain, `prediction_evaluation_semantics` | Locals `predictionV1` (the first pool the interpreter reports), `predictionV2` (outcome counts), `infoGainV2`; version 2. The v2 outcome comes from `evaluatePrediction`, the `prediction.py` rule. |
| `chain_formal_incumbent_reference` | The local `incumbent`, replaced on strict improvement; each replacement is `ctx.observe("incumbent", …)` for monitoring |
| `run_invariants_lock.json`: `resolved_data_scope`, `health_config_sha256`, `advice_sha256`, `run_seed` | The `config` mount (`data_scope.json`, `health_config.yaml`, `advice.md`) and the `data` mount: their content digests are pinned. The seed, workflow digest and alias table are pinned automatically. A mismatch on resume is refused and names the field. |
| Locked knobs (windows, policies, portions, evidence order …) | Constants in `workflow.ts` are covered by the workflow digest. Values in the run input are recorded in the log's `started` event and replayed on resume, so they cannot drift. |
| `run_seed`, `probe_seed_context(run_seed, iteration, attempt)`, `SeedCoordinates` | `ctx.seed` and `probeSeed()`. `Math.random` in the body is seeded from the pin. |
| `llm.json` routes (`interpret`, `data_analysis`, `lit_review.*`, `propose`, `implement`, `validate`, `tune.*`, `judge`, `cache_consolidator`) | `defineModels` alias table. Empty aliases resolve to `default`; callers remap aliases (as `openai-moderate-v1` does). |
| `token_usage.jsonl` | Per-call `usage` in `agent_returned` events of the wallis log |
| Trial/formal time budgets, compute | `budget.computeMinutes` (an attention point). Every `RunCommand` carries the remaining minutes and the process is killed when they are spent. |
| Chain-mode resume (`restore_prior_state`, per-iteration subprocess) | wallis resume re-executes the body against the journal, a cache keyed by node, input and occurrence: unchanged calls hit and the local variables come back with them; a node continues from its last completed turn; an uncaught node failure holds the run until it is restarted or cancelled. |
| `workflow_stop_reason`: `infrastructure_abort` > `target_reached` > `iterations_exhausted` | `StopReason`, plus `no_improvement`, `judge_stop` and `operator_stop`. A spent budget is a pause, not a stop. |
| Script outputs (`train`, `evaluate`, Health, fingerprints, metric order, validator) | `command` adapters with TypeBox inputs and outputs (the default protocol: JSON on stdin and stdout). A mismatch is a typed `CommandFailed(output_mismatch)`. |

## Not expressed, or approximated

These are the gaps between SIDERIUS and this workflow. Each one says why.

### Loop and nodes

1. **Judge strategies.** One judge call replaces rubric-rank (repeats, median,
   exact `Fraction` weighted mean), debate, judge-merge and primary-advisors.
   Not expressed: `MAX_SCORED_ITEMS_PER_CALL`, `MAX_JUDGE_PROMPT_CHARS`, and
   the launch-time `max_judge_calls` check against per-iteration bounds.
   SIDERIUS also removes `candidate_id`; the projection here has no ids to
   remove. The judge's `maxTurns` is 2, not SIDERIUS's single call: wallis
   always offers codemode, and a codemode call is a turn. The consolidator
   is raised from 1 to 2 for the same reason. At its limit a node waits
   for more turns instead of failing.
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
5. **Validator.** The deterministic checks are one placeholder command. The
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
   writes across runs; in wallis, writes leave a run only as artifacts and
   `wallis export`, and mounts are read-only.
8. **Startup.** Not expressed:
   - launch admission;
   - hardware context;
   - the runtime launch self-test;
   - Step 0 seed tuning outputs (`source_paths`), with `seed_summaries` and
     `validate_stamped_invariants` on each restored output.

### Carried state

9. **Narrative cache fields.** Each cache entry holds its own findings,
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
12. **Metric order.** The direction is dynamic in SIDERIUS. Here a command
    reports it, and a sign-normalized `rank_score` ranks in one direction.
    Not expressed: SIDERIUS refuses to cap an unrankable cache (no
    MetricSpec).
13. **Prediction memory.** The v2 rule is body code, comparing the
    iteration's best valid formal score with the incumbent before it. The v1
    pool is the first one the interpreter reports; SIDERIUS carries it from
    restored outputs.
14. **Other carried fields.** Not expressed: `vocab_link_confirmations`
    (promotion after 3 runs), `runtime_vocab`, `previous_proposal_data` and
    `recent_formal_feedback` (last 3), and accumulated gate exhaustions. They
    would be more local variables; nothing in wallis stands in the way.
15. **Folding.** Large history fields reach agents `Foldable` (runs at 6000
    chars, the knowledge cache at 12 000 or 6000, collapse history at 4000):
    over the cap, the prompt shows a skeleton and the full value is the
    `input` variable in codemode. SIDERIUS renders fixed-size prompt
    sections instead. A call whose rendered input does not fit the model's
    window is refused (`input_too_large`), and the body does not catch it.

### Invariants, budgets, resources

16. **Run invariants.** About 45 canonical fields are locked in SIDERIUS.
    Here the `config` and `data` mounts (content digests), the seed and the
    alias table are pinned explicitly; the rest are covered by the workflow
    digest or the recorded input. Not expressed: provenance fields
    (recorded, never compared), the legacy-lock refusals, and per-output
    stamp checks. A mount digest hashes every file, with per-file hashes
    cached by path, mtime and size; a content change that keeps all three
    is not detected.
17. **Advice content.** `interpret` and `propose` read `advice.md` from the
    `config` mount with their read-only fs tools; the body itself still
    cannot read files.
18. **Compute budgets.** SIDERIUS budgets wall time per attempt (Trial and
    Formal), VRAM (`trial_vram_budget_gb`, `gpu_pair_ceiling_gib`), epochs
    and data portions. Here they are command inputs plus one run-level
    `computeMinutes` (a command is killed when it runs out). `train` and
    `evaluate` declare `resources` (GPU, memory) and wait for machine slots;
    VRAM is not measured.
19. **Resource envelope and access policy for data analysis.** Scripts run
    under bubblewrap and see only their input artifacts, their mounts and
    their scratch dir. Not expressed: SIDERIUS's anti-leakage policy
    (which files and columns an analysis may read), per-skill timeouts,
    device and memory envelopes. The analysis agent's `read-only` level is
    enforced by the executor's tool layer.
20. **Scheduling.** `scheduling_mode: parallel` and `host_budget` (parallel
    chains in the candidate worker) are not expressed. The loop is serial.
21. **Telemetry.** SIDERIUS writes token rows labeled by node, iteration and
    character components, plus the `[TOKEN_ITER]` rollup. The wallis log
    keeps per-call usage, and the body observes the iteration and each new
    incumbent (`ctx.observe`, shown by `wallis status`, `tree` and `show`).
22. **Infrastructure halt.** SIDERIUS writes a marker and exits with code 3.
    Here it is only the `infrastructure_abort` stop reason.
23. **Literature cache** (`cache/literature/root_papers`) is not expressed.
24. **`mcp.json` pins are placeholders.** The server packages and versions
    were not checked against a registry.

### wallis prototype limits that affect this example

25. The `trainer`, `checks`, `coding`, `analysis` and MCP sandboxes have
    only met scripted commands and agents in tests; `trainer/` and
    `checks/` hold placeholders, and the lock is a stub. The MCP sandboxes'
    domain allowlists are recorded but not enforced per domain (bwrap
    shares the network when the list is non-empty).
26. Health now runs on every trained checkpoint, in parallel with
    `evaluate`, not only on scored ones; a round's parallel Trial attempts
    all run (more compute than SIDERIUS's stop-at-first-success).
27. The `config` mount holds the advice and the Health config together, so
    `interpret` and `propose` (which read the advice) can also read the
    Health config file, though not the Health code.
28. Nested workflows return their outputs; the main body folds them into
    its local variables.
