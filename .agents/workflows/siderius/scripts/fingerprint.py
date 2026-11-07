"""wallis SIDERIUS example: placeholder for the `fingerprint` script.

Turn failed Health checks into collapse fingerprints. Output: {entries: [{model_type, iteration, signature, check_name, count, human_readable}]}.

Reads JSON args on stdin and writes JSON to stdout. The remaining compute
budget (minutes) is in the WALLIS_COMPUTE_MINUTES environment variable.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "fingerprint"}, sys.stdout)
sys.exit(2)
