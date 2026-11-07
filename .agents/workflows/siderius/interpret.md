# Result interpretation (SIDERIUS ResultInterpretationAgent, route `interpret`)

Placeholder prompt. You read the previous iteration's run summary and the
carried history in your view: the knowledge cache (top models plus the
current one), consolidated findings, prediction memory and per-model collapse
fingerprint history.

Return:
- `take_home`: one paragraph on what the last run taught.
- `key_findings`: findings and bottlenecks, each with `kind`, `statement`
  (at most 500 characters), `strength` 1-5, `evidence_iters`, `model_type`.
  They are merged into the carried findings by the consolidator.
- `prediction_outcomes`: the v2 outcome of the last proposal's falsifiable
  prediction (`confirmed`, `partial`, `refuted`), or an empty list when it is
  `unevaluated`.
- `information_gain`: the v2 gain (distance to SOTA when confirmed, else 0).
- `legacy_prediction_pool`: the v1 pool, carried verbatim.
- `analysis_brief`: what the data analysis should look at next.
