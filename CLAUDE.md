# Watson Voice - Project Instructions

## Build & Test

- Build: `npm run build` (TypeScript → `dist/`)
- Run tests: `npx vitest run` (all tests) or `npx vitest run test/<file>.test.ts`
- Always run `npm run build` after changing source files

## Running the Bot

The bot runs in a tmux session called `watson-voice`.

To restart after code changes:
1. `tmux send-keys -t watson-voice C-c` (stop the bot)
2. Wait ~1 second for graceful shutdown
3. `tmux send-keys -t watson-voice 'node dist/index.js' Enter` (start it)
4. Verify with `tmux capture-pane -t watson-voice -p | tail -10` (look for "Voice pipeline started")

## Related Services

- `whisper-server` — local Whisper STT server (separate tmux session)
- `OpenClaw-Gateway` — gateway sync service (separate tmux session)

## Architecture

- `src/pipeline/voice-pipeline.ts` — main voice processing pipeline (STT → command/LLM → TTS)
- `src/services/voice-commands.ts` — voice command parser (regex-based)
- `src/services/channel-router.ts` — channel switching, forum post creation, history management
- `src/services/claude.ts` — LLM (Claude) integration
- `src/services/tts.ts` — text-to-speech
- `src/services/whisper.ts` — speech-to-text
- `src/discord/` — Discord connection, audio receive/playback
