# Scripted train for the demo: no training. Sleeps a moment, then writes a "checkpoint"
# holding the plugin's text and the scope, so evaluate can score it.
import json, sys, time
q = json.load(sys.stdin)
plugin = open(q["model"]["path"]).read()
time.sleep(1)
open("ckpt.bin", "w").write(plugin + q["scope"])
print(json.dumps({"status": "ok", "checkpoint": "ckpt.bin", "minutes": 2}))
