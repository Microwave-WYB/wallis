# Scripted train: the checkpoint is the plugin's text plus the scope (no training).
import json, sys
q = json.load(sys.stdin)
plugin = open(q["model"]["path"]).read()
open("ckpt.bin", "w").write(plugin + q["scope"])
print(json.dumps({"status": "ok", "checkpoint": "ckpt.bin", "minutes": 2}))
