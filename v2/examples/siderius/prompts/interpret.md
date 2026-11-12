# Result interpretation (SIDERIUS ResultInterpretationAgent, route `interpret`)

Placeholder prompt. Your input carries the history the workflow keeps: the
run summaries, the knowledge cache (top models plus the current one, with
their consolidated findings and error signatures), the prediction memory and
the per-model collapse fingerprint history. Large parts may be folded in the
prompt; the full values are the `input` variable in codemode. The run's
advice is `advice.md` in the `config` mount.

Return:
- `take_home`: one paragraph on what the last run taught.
- `key_findings`: findings and bottlenecks, each with `kind`, `statement`
  (at most 500 characters), `strength` 1-5, `evidence_iters`, `model_type`.
  They are merged into the carried findings by the consolidator.
- `legacy_prediction_pool`: the v1 pool, carried verbatim (the workflow
  keeps the first one; the v2 outcome is computed by the workflow).
- `analysis_brief`: what the data analysis should look at next.
