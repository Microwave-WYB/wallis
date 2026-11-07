import torch

from common import build, run, setup


def main(inp):
    config = inp.get("config", {})
    setup(config)
    try:
        model = build(inp["model_path"], config)
        model.eval()
        with torch.no_grad():
            out = model(torch.rand(4, 1, 8, 8))
        if tuple(out.shape) != (4, 10):
            return {"passed": False, "error": f"expected output shape [4, 10], got {list(out.shape)}"}
        if not torch.isfinite(out).all():
            return {"passed": False, "error": "output contains non-finite values"}
    except Exception as e:
        return {"passed": False, "error": f"{type(e).__name__}: {e}"}
    return {"passed": True, "error": None}


run(main)
