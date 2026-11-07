# Comparison task: a SIDERIUS-style model research loop

Both arms build the same thing from this spec. Arm A writes a small custom
program against the pi SDK, guided only by `skill/SKILL.md`. Arm B writes a
wallis workflow, guided only by `wallis docs`.

## Goal

Search for a small PyTorch classifier that maximizes **test accuracy** on the
scikit-learn `digits` dataset (8x8 images, 10 classes, 1797 samples). Training
must run on CPU.

## Fixed harness (Python, written once, shared by both arms)

- Split: stratified 60/20/20 train/validation/test with seed 0. The split and
  the test labels are never visible to agents.
- `train`: takes a model file and a config, trains with a fixed CPU budget of
  60 seconds per run, writes a checkpoint and the validation accuracy.
- `evaluate`: reports test accuracy for a checkpoint.
- `health`: flags collapse, i.e. one class taking more than 50% of
  predictions, or fewer than 8 distinct predicted classes.

## Loop (3 iterations)

1. **interpret**: summarize the previous iterations (none on the first).
2. **propose**: propose one architecture, including a hypothesis and a
   predicted validation accuracy.
3. **implement**: write `model.py` exposing `build_model(config) -> nn.Module`
   for input `[B, 1, 8, 8]` and output `[B, 10]`. The implementor may try
   running its own code on random tensors, but must not be able to read the
   harness's evaluate or health code, or any labels.
4. **check**: a shape and forward-pass check. On failure, give the error back
   to the implementor once.
5. **train → evaluate + health**: run evaluate and health in parallel.
6. Carry forward per-iteration summaries, the best healthy model so far, and
   collapse findings.

The output is the best healthy model, its test accuracy, and a short report.

## Rules

- Same model for all agents in both arms (to be chosen by the owner).
- No paid model calls until the owner approves the provider and key. Build
  and dry-run with pi's faux provider first.
- Use build-guard for builds and tests.

## Measurements

| # | What | How |
| --- | --- | --- |
| 1 | Development cost | builder agent's turns, wall time, lines of code (excluding the shared harness), whether the first real run succeeded |
| 2 | Result | best test accuracy, number of model turns used |
| 3 | Crash mid-run | SIGKILL during iteration 2's training; resume; record what was redone |
| 4 | Code change | change the interpret prompt after iteration 2; rerun; record what was redone |
| 5 | Isolation | can the implementor read harness/evaluate.py, health code or labels? Try it deliberately |
| 6 | Debuggability | time to answer "why did iteration 2's model fail health?" from the artifacts |
| 7 | Owner's impression | free text |
