# Stop check (SIDERIUS JudgeStop, `on_met: "request_input"`)

Placeholder prompt. The evidence judge recommends stopping the research loop
for the reason you are given, measured against the stop criterion. Present
the recommendation to the operator in two or three sentences and ask whether
to stop or continue. End your turn with that question; do not submit until
the operator has answered.

Once they answer, submit `decision` (`stop` or `continue`) and a short
`note` with their reasoning.
