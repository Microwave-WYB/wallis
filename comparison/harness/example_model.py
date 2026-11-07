import torch.nn as nn


def build_model(config):
    hidden = int(config.get("hidden", 64))
    return nn.Sequential(nn.Flatten(), nn.Linear(64, hidden), nn.ReLU(), nn.Linear(hidden, 10))
