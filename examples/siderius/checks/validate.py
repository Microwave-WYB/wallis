"""wallis SIDERIUS example: placeholder for the `validate` command.

Deterministic validator checks 1-7 and 9 (plugin load, pytest, description, scalar config, AST, instantiation, gradient flow, output shape, inheritance). Output: {passed, report, error}.

Reads its JSON input on stdin (artifacts with their mounted `path`) and writes JSON to stdout.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "validate"}, sys.stdout)
sys.exit(2)
