# AGENTS.md — Watson Voice

A Discord voice bot for hands-free conversational AI. Watson joins a voice channel, listens via STT, generates responses through an LLM (via OpenClaw gateway), and speaks back using TTS. Supports multiple backends, voice commands, channel routing, and an inbox/queue system.

## Commands

```bash
# Build
npm run build                    # TypeScript → dist/

# Test
npx vitest run                   # All unit tests
npx vitest run test/<file>       # Single test file
npm run test:flows               # Interaction flow harness (no Discord needed)
npm run test:intents             # Intent robustness matrix
npm run flows:report             # Scenario pass/fail report
npm run flows:stress             # Concurrency stress tests
npm run e2e:live                 # Live Discord + gateway integration

# Run
node dist/index.js               # Start the bot (usually via tmux, see below)

# Utilities
npm run -s session:repair-thread -- --thread='<name>'   # Repair split thread session
```

## Running in Production

The bot runs in a tmux session on the Mac Mini:

```bash
# Restart after code changes
npm run build
tmux send-keys -t watson-voice C-c
sleep 1
tmux send-keys -t watson-voice '/opt/homebrew/opt/node@22/bin/node dist/index.js' Enter

# Verify
tmux capture-pane -t watson-voice -p | tail -10
# Look for "Voice pipeline started"
```

**Use Node 22 for runtime.** Node 24 breaks the Opus native binary. Node 18 lacks `WebSocket` (disables gateway sync).

## Dependencies (External Services)

Watson Voice requires these running alongside it:

| Service | tmux session | What it does |
|---------|-------------|--------------|
| Whisper STT | `whisper-server` | Local speech-to-text (whisper.cpp) |
| Kokoro TTS | `kokoro` | Local text-to-speech (primary) |
| Chatterbox TTS | `chatterbox` | Local TTS with voice cloning (fallback) |
| OpenClaw Gateway | `OpenClaw-Gateway` | LLM routing + session management |

Check status: `~health` text command or `"Watson, settings"` voice command.

## Project Structure

```
src/
├── index.ts                      # Entry point, text commands, auto-join/leave
├── config.ts                     # Env var loading & validation
├── channels.json                 # Channel definitions (gitignored)
├── audio/
│   ├── earcons.ts                # Audio cue synthesis (listening, acknowledged, etc.)
│   ├── silence-detector.ts       # RMS energy-based VAD
│   ├── waiting-sound.ts          # Hold tone during LLM processing
│   └── wav-utils.ts              # WAV file helpers
├── discord/
│   ├── client.ts                 # Discord.js client setup
│   ├── voice-connection.ts       # Voice channel connection management
│   ├── audio-receiver.ts         # Captures voice → PCM audio
│   └── audio-player.ts           # Plays TTS/earcons to voice channel
├── pipeline/                     # ⭐ Core orchestration
│   ├── voice-pipeline.ts         # Main pipeline: STT → command/LLM → TTS
│   ├── pipeline-state.ts         # State machine (IDLE, TRANSCRIBING, PROCESSING, etc.)
│   ├── pipeline-invariants.ts    # State validation & invariant checks
│   ├── transient-context.ts      # Ephemeral per-utterance context
│   └── interaction-contract.ts   # Pipeline interface contracts
├── services/
│   ├── whisper.ts                # STT backends (local Whisper / OpenAI)
│   ├── tts.ts                    # TTS routing (Kokoro / Chatterbox / ElevenLabs)
│   ├── elevenlabs.ts             # ElevenLabs streaming TTS
│   ├── voice-commands.ts         # Wake-word command parser (regex)
│   ├── voice-settings.ts         # Runtime VAD/silence settings
│   ├── channel-router.ts         # Channel switching, prompt composition, history
│   ├── claude.ts                 # LLM calls via OpenClaw gateway
│   ├── queue-state.ts            # Wait/inbox/ask mode state
│   ├── inbox-tracker.ts          # Unread activity tracking across channels
│   ├── response-poller.ts        # Polls gateway for completed queue items
│   ├── gateway-sync.ts           # WebSocket sync with OpenClaw text sessions
│   ├── session-transcript.ts     # JSONL session recording
│   ├── health-monitor.ts         # System health tracking
│   ├── health-snapshot.ts        # Health state snapshots
│   └── dependency-monitor.ts     # STT/TTS service monitoring + auto-restart
└── testing/                      # Test harnesses and reports
```

## Architecture

### Data Flow
```
User speaks → AudioReceiver (Opus→PCM) → SilenceDetector (speech boundary)
  → Whisper STT (audio→text) → VoiceCommandParser
    → [if command] → handle locally (earcon + action)
    → [if conversation] → OpenClaw Gateway (LLM) → TTS → AudioPlayer → Discord
```

### Key Concepts

**Pipeline State Machine** (`pipeline-state.ts`): The heart of the system. States: IDLE, TRANSCRIBING, PROCESSING, SPEAKING, AWAITING_* (multi-step flows), NEW_POST_FLOW, INBOX_FLOW. Each state produces TransitionEffects (earcons, speech, playback). Understanding this state machine is essential for debugging.

**Gateway Sync** (`gateway-sync.ts`): Bidirectional sync with OpenClaw. Voice transcripts get injected into text sessions so Watson (text) and Watson Voice share history. Uses Ed25519 device identity, WebSocket with auto-reconnect.

**Channel Router** (`channel-router.ts`): Maps voice sessions to Discord channels. Each channel has a display name, Discord channel ID, topic prompt, and OpenClaw session key. Supports static channels (channels.json), ad-hoc switching by ID, and LLM-assisted fuzzy matching.

**Voice Modes**: Wait (synchronous), Inbox/Queue (fire-and-forget with later review), Ask (per-message choice). Queue state persists to `~/clawd/voice-queue-state.json`.

**Inbox System**: Tracks unread messages across channels. "Check inbox" summarizes activity. "Next" walks through responses. Designed as a persistent home base / mission control (see docs/design/).

### Voice Commands
Wake-word triggered (`"Watson, <command>"`). Key categories:
- **Navigation**: switch channel, list channels, go home/default
- **Dispatch**: fire-and-forget to another channel
- **Inbox**: check inbox, next, clear, mode switch
- **Playback**: pause, replay, hear full message
- **Settings**: noise threshold, silence delay, gated/open mode
- **Forum**: create new post (guided multi-step flow)

### Gated vs Open Mode
- **Gated** (default): Only responds to wake-word-prefixed commands. 5-second grace period after Watson speaks.
- **Open**: Processes all speech. Useful when solo in channel.

## Testing

**Automated (no Discord):**
- `npm run test:flows` — deterministic interaction flow harness, validates state transitions
- `npm run test:intents` — STT variant robustness testing
- `npm run flows:stress` — concurrency and overlap scenarios

**Live (requires Discord + Gateway):**
- `npm run e2e:live` — auth, channel routing, gateway roundtrips
- `npm run e2e:voice-loop` — full voice pipeline with synthesized speech

## Code Style

- TypeScript strict mode
- Async/await throughout (no raw callbacks)
- State machine transitions produce effects, pipeline applies them (separation of concerns)
- Earcons provide non-verbal UX feedback — every state transition should have appropriate audio cue

## Git Workflow

- Feature branches off `main`
- Build must pass before committing
- Test with `npx vitest run` before pushing

## Boundaries

- **DO NOT** modify `src/channels.json` without asking — it contains production channel mappings
- **DO NOT** restart the bot without building first (`npm run build`)
- **DO NOT** change Discord token or gateway credentials
- **DO NOT** modify `.env` without understanding the implications on the running tmux session
- **Always** run tests after changes: `npx vitest run`

## Known Issues

See `docs/known-issues.md` for current bugs and workarounds.

The most significant ongoing issue is **text/audio session sync** — voice and text sessions can drift out of alignment. See `docs/debugging/audio-text-sync.md` for the full investigation journal.

## Related Systems

- **OpenClaw Gateway** (`~/clawd/`) — LLM routing, session management, the text-side of Watson
- **Shared skills** — reusable agent skills live at `~/clawd/skills/`; symlink into this repo's `skills/` as needed
- **Obsidian thread** — long-running design notes at `~/Documents/main/AI/Threads/Watson Voice.md`

## Environment Variables

See `.env.example` for the complete list. Key groups:

- **Discord**: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_VOICE_CHANNEL_ID`
- **Gateway**: `GATEWAY_URL`, `GATEWAY_TOKEN`, `GATEWAY_AGENT_ID`, `GATEWAY_WS_SYNC`
- **STT**: `WHISPER_URL` (local) or `OPENAI_API_KEY` (cloud fallback)
- **TTS**: `TTS_BACKEND`, `TTS_FALLBACK_BACKEND`, `KOKORO_URL`, `CHATTERBOX_URL`, `ELEVENLABS_API_KEY`
- **Voice tuning**: `SILENCE_DURATION_MS`, `SPEECH_THRESHOLD`, `MIN_SPEECH_DURATION_MS`
- **Monitoring**: `DEPENDENCY_HEALTHCHECK_MS`, `DEPENDENCY_AUTO_RESTART`
