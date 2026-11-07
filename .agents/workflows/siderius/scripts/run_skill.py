"""wallis SIDERIUS example: placeholder for the `run_skill` script.

Serve the data-analysis tool run_skill: run one authorized analysis skill under the access policy. Output: {result_ref, summary}.

Reads JSON args on stdin and writes JSON to stdout. The remaining compute
budget (minutes) is in the WALLIS_COMPUTE_MINUTES environment variable.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "run_skill"}, sys.stdout)
sys.exit(2)
