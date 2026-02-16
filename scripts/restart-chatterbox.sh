#!/usr/bin/env bash
set -euo pipefail

if ! tmux has-session -t chatterbox 2>/dev/null; then
  tmux new-session -d -s chatterbox
fi

tmux send-keys -t chatterbox:0.0 C-c
sleep 1
tmux send-keys -t chatterbox:0.0 "cd ~/chatterbox-tts-api && source .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 4123" C-m
