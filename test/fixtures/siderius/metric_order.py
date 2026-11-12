import json, sys
json.load(sys.stdin)
print(json.dumps({"metric_id": "mse_gain", "direction": "higher_is_better"}))
