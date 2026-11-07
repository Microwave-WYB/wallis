"""wallis SIDERIUS example: placeholder for the `metric_order` script.

Reconcile the run's MetricSpec and report its direction. Output: {metric_id, direction (higher_is_better|lower_is_better)}.

Reads JSON args on stdin and writes JSON to stdout. The remaining compute
budget (minutes) is in the WALLIS_COMPUTE_MINUTES environment variable.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "metric_order"}, sys.stdout)
sys.exit(2)
