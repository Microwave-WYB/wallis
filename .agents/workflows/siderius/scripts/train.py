"""wallis SIDERIUS example: placeholder for the `train` script.

Train one candidate config. Args: config, scope (trial|formal), max_epochs, time_budget_minutes, seed, data_scope. Output: {status, checkpoint, minutes, oom}.

Reads JSON args on stdin and writes JSON to stdout. The remaining compute
budget (minutes) is in the WALLIS_COMPUTE_MINUTES environment variable.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "train"}, sys.stdout)
sys.exit(2)
