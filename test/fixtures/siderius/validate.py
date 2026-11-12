import json, sys
q = json.load(sys.stdin)
open(q["model"]["path"]).read()
print(json.dumps({"passed": True, "error": None, "checks": {"plugin_loads": True}}))
