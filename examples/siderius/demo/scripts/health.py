# Scripted Health: model m2 collapses its variance (invalid); the others pass.
import json, sys
q = json.load(sys.stdin)
bad = q["model_type"] == "m2"
checks = [{"check_name": "variance_collapse", "metrics": {"ratio": 0.1}}] if bad else []
print(json.dumps({"valid": not bad, "policy": "blocking", "failed_checks": checks}))
