"""wallis SIDERIUS example: placeholder for the `health` command.

Run the scientific Health gates from health_config on a scored checkpoint. Output: {valid, policy (blocking|recording), failed_checks: [{check_name, metrics}]}.

Reads its JSON input on stdin (artifacts with their mounted `path`) and writes JSON to stdout.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "health"}, sys.stdout)
sys.exit(2)
