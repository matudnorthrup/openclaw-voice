#!/usr/bin/env bash
set -euo pipefail

tmux send-keys -t kokoro:0 C-c
sleep 1
tmux send-keys -t kokoro:0 "cd ~/Kokoro-FastAPI && source .venv/bin/activate && USE_GPU=false DEVICE_TYPE=cpu python -m uvicorn api.src.main:app --host 0.0.0.0 --port 8880" C-m
