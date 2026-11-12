"""Each pair's density range (the min of both halves' lo) and the roll's channel ratios.
usage: measure_roll.py '{"dmin": [...], "pairs": [{frame, a, b}]}' -> {ratio, lo: {frame: rgb}}"""
import sys, json
q = json.loads(sys.argv[1])
print(json.dumps(dict(ratio=[1.0, 1.0, 1.0], lo={p['frame']: [min(x, y) for x, y in zip(p['a'], p['b'])] for p in q['pairs']})))
