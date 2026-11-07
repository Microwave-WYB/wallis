"""Digits data: scaled to [0,1], [N,1,8,8], stratified 60/20/20 split, seed 0."""
import os

import numpy as np
from sklearn.datasets import load_digits
from sklearn.model_selection import train_test_split

PRIVATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "private")
SPLIT = os.path.join(PRIVATE, "split.npz")


def make_split():
    d = load_digits()
    x = (d.data / 16.0).astype(np.float32).reshape(-1, 1, 8, 8)
    y = d.target.astype(np.int64)
    x_tr, x_rest, y_tr, y_rest = train_test_split(
        x, y, test_size=0.4, stratify=y, random_state=0)
    x_va, x_te, y_va, y_te = train_test_split(
        x_rest, y_rest, test_size=0.5, stratify=y_rest, random_state=0)
    return dict(x_train=x_tr, y_train=y_tr, x_val=x_va, y_val=y_va,
                x_test=x_te, y_test=y_te)


def load_split():
    """Load the split, writing it to private/split.npz on first use."""
    if not os.path.exists(SPLIT):
        os.makedirs(PRIVATE, exist_ok=True)
        np.savez(SPLIT, **make_split())
    with np.load(SPLIT) as z:
        return {k: z[k] for k in z.files}


if __name__ == "__main__":
    s = load_split()
    print({k: v.shape for k, v in s.items()})
