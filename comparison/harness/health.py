import torch

from common import build, predict, run, setup
from data import load_split


def main(inp):
    config = inp.get("config", {})
    setup(config)
    s = load_split()
    model = build(inp["model_path"], config)
    model.load_state_dict(torch.load(inp["checkpoint"], weights_only=True))
    pred = predict(model, torch.from_numpy(s["x_test"]))
    counts = torch.bincount(pred, minlength=10)
    dominant = counts.max().item() / len(pred)
    distinct = int((counts > 0).sum().item())
    reasons = []
    if dominant > 0.5:
        reasons.append(f"one class takes {dominant:.0%} of predictions (>50%)")
    if distinct < 8:
        reasons.append(f"only {distinct} distinct classes predicted (<8)")
    return {"valid": not reasons, "dominant_fraction": dominant,
            "distinct_classes": distinct, "reason": "; ".join(reasons) or None}


run(main)
