import json, sys
q = json.load(sys.stdin)
print(json.dumps({"entries": [{"model_type": q["model_type"], "iteration": q["iteration"], "signature": "var<0.2", "check_name": "variance_collapse", "count": 1, "human_readable": "variance collapsed"}]}))
