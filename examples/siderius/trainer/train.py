"""wallis SIDERIUS example: placeholder for the `train` command.

Train one candidate config. Args: model (an artifact ref; the plugin is
mounted read-only; its path is in the input (`model.path`)), config, scope
(trial|formal), max_epochs, time_budget_minutes, seed, data_scope. The
dataset is the read-only mount at /data (cwd is /w, the call's scratch dir). Output: {status,
checkpoint, minutes}, where checkpoint is the name of the checkpoint file written in /w (or null);
the command's parse turns it into an artifact.

Reads its JSON input on stdin and writes JSON to stdout.
This placeholder does no work.
"""

import json
import sys

json.load(sys.stdin)
json.dump({"placeholder": "train"}, sys.stdout)
sys.exit(2)
