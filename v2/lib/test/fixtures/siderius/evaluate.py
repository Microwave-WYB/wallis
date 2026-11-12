# Scripted evaluate: the score follows from the checkpoint (its model type and scope), never from call order.
import json, re, sys
q = json.load(sys.stdin)
ckpt = open(q["checkpoint"]["path"]).read()
n = int(re.search(r"# m(\d+)", ckpt).group(1))
scores = [(0.1, 0.2), (0.3, 0.9), (0.8, 0.7), (0.05, 0.06), (0.4, 0.5), (0.2, 0.25), (0.01, 0.02)]
trial, formal = scores[n] if n < len(scores) else (0.0, 0.0)
print(json.dumps({"scoreable": True, "metric_id": "mse_gain", "score": formal if ckpt.endswith("formal") else trial}))
