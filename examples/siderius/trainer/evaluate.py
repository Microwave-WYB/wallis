"""wallis SIDERIUS example: placeholder for the `evaluate` command.

Score a trained checkpoint on the trial or formal evaluation portion. Output: {scoreable, score, metric_id}.

Reads its JSON input on stdin (artifacts with their mounted `path`) and writes JSON to stdout.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "evaluate"}, sys.stdout)
sys.exit(2)
