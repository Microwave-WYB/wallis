"""wallis SIDERIUS example: placeholder for the `metric_order` command.

Reconcile the run's MetricSpec and report its direction. Output: {metric_id, direction (higher_is_better|lower_is_better)}.

Reads its JSON input on stdin (artifacts with their mounted `path`) and writes JSON to stdout.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "metric_order"}, sys.stdout)
sys.exit(2)
