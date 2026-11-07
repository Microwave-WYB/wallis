"""Harness step: read the config from argv[1] (JSON), write {"score"} to
argv[2]. A real harness imports torch, trains and evaluates here; it never
calls a model API. It runs sandboxed: /harness read-only, /work writable."""

import json
import sys

with open(sys.argv[1]) as f:
    config = json.load(f)
# A toy objective with its best at lr=0.01, epochs=20.
score = 1.0 - abs(config["lr"] - 0.01) * 10 - abs(config["epochs"] - 20) / 100
with open(sys.argv[2], "w") as f:
    json.dump({"score": round(score, 6)}, f)
