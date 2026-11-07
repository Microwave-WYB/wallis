# Shared harness (digits)

Fixed Python harness shared by both arms. CPU-only torch, single thread,
`torch.manual_seed(config.get("seed", 0))`. Each script reads its input JSON
from `argv[1]` and writes its output JSON to `argv[2]`; on error it exits
nonzero with a short message on stderr.

Run (from this directory):

    uv run --frozen --offline python <script> in.json out.json

| Script | Input | Output |
| --- | --- | --- |
| `check.py` | `{model_path, config}` | `{passed, error}` (forward on random `[4,1,8,8]`, output must be finite `[4,10]`) |
| `train.py` | `{model_path, config, out_dir, budget_seconds=60}` | `{val_accuracy, epochs_run, seconds, checkpoint}` (`out_dir/ckpt.pt`; config: `lr`=1e-3, `batch_size`=32, `epochs`=30, `seed`) |
| `evaluate.py` | `{model_path, config, checkpoint}` | `{test_accuracy}` |
| `health.py` | `{model_path, config, checkpoint}` | `{valid, dominant_fraction, distinct_classes, reason}` (invalid if a class has >50% of predictions or <8 classes predicted) |
| `example_model.py` | n/a | tiny MLP exposing `build_model(config)`; used by the tests |

`model_path` must expose `build_model(config) -> nn.Module` for `[B,1,8,8]` -> `[B,10]`.

## Private files: never bind into an agent's sandbox

- `private/split.npz`: the split arrays, including the test labels. Created on
  first use by `data.py` (stratified 60/20/20, seed 0); git-ignored.
- `evaluate.py`, `health.py`, `data.py` (they load the test split; an agent
  that can read them learns how to reach the labels). Bind only the model file
  and a writable scratch directory; run the scripts host-side.

## Smoke test

    ./smoke.sh

Runs check -> train (10 s budget) -> evaluate -> health on `example_model.py`.
