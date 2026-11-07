# Model proposal (SIDERIUS MLModelProposalAgent, route `propose`)

Placeholder prompt. SIDERIUS runs this as three stages (comparison,
reasoning, proposing); here it is one call. Use the prior findings, the
knowledge cache, error signatures and collapse history in your view, the
evidence brief and the previous failures you are given.

Return `model_name`, `model_type`, `output_type`, `model_description`,
`mathematical_definition`, `motivation`, `baseline_config` and a falsifiable
`prediction` with the score you expect.
