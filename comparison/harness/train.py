import os
import time

import torch
import torch.nn.functional as F

from common import build, predict, run, setup
from data import load_split


def main(inp):
    config = inp.get("config", {})
    budget = float(inp.get("budget_seconds", 60))
    t0 = time.monotonic()
    setup(config)
    s = load_split()
    xt, yt = torch.from_numpy(s["x_train"]), torch.from_numpy(s["y_train"])
    xv, yv = torch.from_numpy(s["x_val"]), torch.from_numpy(s["y_val"])
    model = build(inp["model_path"], config)
    lr = float(config.get("lr", 1e-3))
    bs = int(config.get("batch_size", 32))
    epochs = int(config.get("epochs", 30))
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    epochs_run = 0
    for _ in range(epochs):
        if time.monotonic() - t0 >= budget:
            break
        model.train()
        perm = torch.randperm(len(xt))
        for i in range(0, len(xt), bs):
            idx = perm[i:i + bs]
            opt.zero_grad()
            F.cross_entropy(model(xt[idx]), yt[idx]).backward()
            opt.step()
            if time.monotonic() - t0 >= budget:
                break
        epochs_run += 1
    val_acc = (predict(model, xv) == yv).float().mean().item()
    os.makedirs(inp["out_dir"], exist_ok=True)
    ckpt = os.path.join(inp["out_dir"], "ckpt.pt")
    torch.save(model.state_dict(), ckpt)
    return {"val_accuracy": val_acc, "epochs_run": epochs_run,
            "seconds": time.monotonic() - t0, "checkpoint": ckpt}


run(main)
