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
    return {"test_accuracy": (pred == torch.from_numpy(s["y_test"])).float().mean().item()}


run(main)
