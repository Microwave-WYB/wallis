#!/usr/bin/env bash
# Smoke test: check -> train (10 s budget) -> evaluate -> health on example_model.py
set -euo pipefail
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
model=$PWD/example_model.py
cfg='{"hidden": 64, "lr": 0.003, "epochs": 40}'
run() { uv run --frozen --offline python "$1.py" "$tmp/$1.in.json" "$tmp/$1.out.json"; echo "$1: $(cat "$tmp/$1.out.json")"; }

echo "{\"model_path\":\"$model\",\"config\":$cfg}" > "$tmp/check.in.json"
run check
grep -q '"passed": true' "$tmp/check.out.json"
echo "{\"model_path\":\"$model\",\"config\":$cfg,\"out_dir\":\"$tmp/out\",\"budget_seconds\":10}" > "$tmp/train.in.json"
run train
for s in evaluate health; do
  echo "{\"model_path\":\"$model\",\"config\":$cfg,\"checkpoint\":\"$tmp/out/ckpt.pt\"}" > "$tmp/$s.in.json"
  run "$s"
done
grep -q '"valid": true' "$tmp/health.out.json"
echo "SMOKE OK"
