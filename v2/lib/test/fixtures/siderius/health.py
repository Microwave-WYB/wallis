import json, sys
json.load(sys.stdin)
print(json.dumps({"valid": True, "policy": "blocking", "failed_checks": [{"check_name": "variance_collapse", "metrics": {"ratio": 0.1}}]}))
