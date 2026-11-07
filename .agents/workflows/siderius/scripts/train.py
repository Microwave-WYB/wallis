"""wallis SIDERIUS example: placeholder for the `train` script.

Train one candidate config. Args: model (an artifact ref; the plugin is
mounted read-only at $WALLIS_INPUTS/<sha256 hex>/<name>), config, scope
(trial|formal), max_epochs, time_budget_minutes, seed, data_scope. The
dataset is mounted read-only at $WALLIS_DATA_SIDERIUS_DATA. Output: {status,
checkpoint, minutes}, where checkpoint is an artifact draft
{"artifact": "<file in $WALLIS_SCRATCH>", "media": "application/x-checkpoint"}.

Reads JSON args on stdin and writes JSON to stdout. The remaining compute
budget (minutes) is in the WALLIS_COMPUTE_MINUTES environment variable.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "train"}, sys.stdout)
sys.exit(2)
