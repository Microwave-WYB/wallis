# Findings consolidation (SIDERIUS cache_consolidator.list_merge)

Placeholder prompt. You get `current` findings, `incoming` findings and
`max`. Apply the four rules: merge same-meaning items (union
`evidence_iters`, keep the max strength); mark supersession as
`[SUPERSEDES iter-N: <at most 80 chars>]`; keep contradictions as two items
marked `[CONFLICT iter-N vs iter-M]`; keep distinct items.

Return `items` (at most `max`, ranked by strength, then number of
evidence iterations, then latest iteration) and `archived` (everything
dropped, unchanged).
