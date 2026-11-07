"""wallis SIDERIUS example: placeholder for the `train` command.

Train one candidate config. Args: model (an artifact ref; the plugin is
mounted read-only; its path is in the input (`model.path`)), config, scope
(trial|formal), max_epochs, time_budget_minutes, seed, data_scope. The
dataset is the read-only mount at /w/data (cwd is /w, the call's scratch dir). Output: {status,
checkpoint, minutes}, where checkpoint is an artifact draft
{"artifact": "<file in the scratch dir>", "media": "application/x-checkpoint"}.

Reads its JSON input on stdin and writes JSON to stdout. The remaining compute
budget (minutes) is in the WALLIS_COMPUTE_MINUTES environment variable.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "train"}, sys.stdout)
sys.exit(2)
