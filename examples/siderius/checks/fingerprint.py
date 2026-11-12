"""wallis SIDERIUS example: placeholder for the `fingerprint` command.

Turn failed Health checks into collapse fingerprints. Output: {entries: [{model_type, iteration, signature, check_name, count, human_readable}]}.

Reads its JSON input on stdin (artifacts with their mounted `path`) and writes JSON to stdout.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "fingerprint"}, sys.stdout)
sys.exit(2)
