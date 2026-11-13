import json, sys
q = json.load(sys.stdin)
entries = [{"model_type": q["model_type"], "iteration": q["iteration"], "signature": "var<0.2", "check_name": c["check_name"], "count": 1, "human_readable": "variance collapsed"} for c in q["failed_checks"]]
print(json.dumps({"entries": entries}))
