"""Shared helpers for the harness scripts (JSON I/O, model loading, seeding)."""
import importlib.util
import json
import sys

import torch


def run(main):
    """Run main(input_dict) -> output_dict with argv[1] -> argv[2] JSON I/O."""
    if len(sys.argv) != 3:
        sys.exit("usage: <script> in.json out.json")
    try:
        with open(sys.argv[1]) as f:
            inp = json.load(f)
        out = main(inp)
        with open(sys.argv[2], "w") as f:
            json.dump(out, f)
    except Exception as e:  # short message, nonzero exit
        sys.exit(f"{type(e).__name__}: {e}")


def setup(config):
    torch.set_num_threads(1)
    torch.manual_seed(int(config.get("seed", 0)))


def build(model_path, config):
    spec = importlib.util.spec_from_file_location("agent_model", model_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {model_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.build_model(config)


def predict(model, x):
    model.eval()
    with torch.no_grad():
        return model(x).argmax(dim=1)
