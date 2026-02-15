#!/usr/bin/env bash
set -euo pipefail

tmux has-session -t chatterbox 2>/dev/null || tmux new-session -d -s chatterbox

tmux send-keys -t chatterbox:0 C-c
sleep 1
tmux send-keys -t chatterbox:0 "cd ~/chatterbox-tts-api && source .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 4123" C-m
