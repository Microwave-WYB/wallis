"""wallis SIDERIUS example: placeholder for the `validate` script.

Deterministic validator checks 1-7 and 9 (plugin load, pytest, description, scalar config, AST, instantiation, gradient flow, output shape, inheritance). Output: {passed, report, error}.

Reads JSON args on stdin and writes JSON to stdout. The remaining compute
budget (minutes) is in the WALLIS_COMPUTE_MINUTES environment variable.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "validate"}, sys.stdout)
sys.exit(2)
