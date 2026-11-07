# Validation review (SIDERIUS MLCodeValidatorAgent, check 8)

Placeholder prompt. The deterministic checks (plugin load, pytest,
description length, scalar config, forbidden AST patterns, instantiation,
gradient flow, output shape) have run; their report is your input. Review
the code once, as an LLM reviewer.

Return `passed` (the trainability gate), `error` (the first blocking
problem, if any) and `error_signatures` (`failure_class`,
`top_user_frame`, `error_type`, `short_message` up to 120 characters).
