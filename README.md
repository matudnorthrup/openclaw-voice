# Watson Voice

A Discord voice bot for hands-free conversational AI. Watson joins a voice channel, listens via speech-to-text, generates responses through an LLM (via OpenClaw gateway), and speaks back using text-to-speech. It supports multiple STT/TTS backends, voice command navigation, an inbox/queue system, channel switching, and forum post creation.

## Architecture

```
                          ┌─────────────────┐
                          │  Discord Voice   │
                          │  Channel (Input) │
                          └────────┬─────────┘
                                   │ Opus audio
                                   ▼
                        ┌──────────────────────┐
                        │  Silence Detector /   │
                        │  Voice Activity (VAD) │
                        └──────────┬───────────┘
                                   │ WAV buffer
                          ┌────────┴────────┐
                          │   STT Backend   │
                          │  ┌────────────┐ │
                          │  │Local Whisper│ │  ← preferred
                          │  │  (server)   │ │
                          │  ├────────────┤ │
                          │  │OpenAI      │ │  ← cloud fallback
                          │  │Whisper API │ │
                          │  └────────────┘ │
                          └────────┬────────┘
                                   │ transcript text
                                   ▼
                        ┌──────────────────────┐
                        │  Voice Command Parser │──── earcon / local action
                        └──────────┬───────────┘
                                   │ (if not a command)
                                   ▼
                        ┌──────────────────────┐
                        │  OpenClaw Gateway     │
                        │  (LLM — Claude)       │
                        └──────────┬───────────┘
                                   │ response text
                          ┌────────┴────────┐
                          │   TTS Backend   │
                          │  ┌────────────┐ │
                          │  │  Kokoro    │ │  ← local
                          │  ├────────────┤ │
                          │  │ Chatterbox │ │  ← local
                          │  ├────────────┤ │
                          │  │ ElevenLabs │ │  ← cloud
                          │  └────────────┘ │
                          └────────┬────────┘
                                   │ audio stream
                                   ▼
                          ┌─────────────────┐
                          │  Discord Voice   │
                          │ Channel (Output) │
                          └─────────────────┘
```

- **Audio capture**: Listens to voice channel members, detects speech boundaries via silence/VAD detection
- **Speech-to-text**: Local Whisper server (preferred) or OpenAI Whisper API (cloud fallback)
- **Voice commands**: Regex-based parser handles navigation, mode switching, playback control, and more — without hitting the LLM
- **LLM**: Routes through an [OpenClaw](https://github.com/matudnorthrup/openclaw) gateway (OpenAI-compatible `/v1/chat/completions` endpoint)
- **Text-to-speech**: Kokoro (local), Chatterbox (local), or ElevenLabs (cloud) with automatic failover
- **Channel routing**: Switch between topic-specific Discord channels, each with their own system prompt, conversation history, and transcript logging
- **Inbox system**: Queue mode lets you dispatch messages and navigate responses asynchronously

## Prerequisites

- **Node.js 18+** (run `nvm use` if you have nvm — the repo includes `.nvmrc`)
- **System build tools** for native dependencies (`@discordjs/opus`, `sodium-native`):
  - macOS: `xcode-select --install`
  - Ubuntu/Debian: `sudo apt install build-essential python3`
- A **Discord bot** (see [Discord Bot Setup](#discord-bot-setup) below)
- An **[OpenClaw](https://github.com/matudnorthrup/openclaw) gateway** instance running locally
- **At least one STT backend**:
  - Local [Whisper server](https://github.com/ggerganov/whisper.cpp) (recommended), OR
  - OpenAI API key (for cloud Whisper)
- **At least one TTS backend** (optional — the bot functions without TTS but can't speak):
  - [Kokoro](https://github.com/remsky/Kokoro-FastAPI) local server (recommended), OR
  - [Chatterbox](https://github.com/resemble-ai/chatterbox) local server, OR
  - ElevenLabs API key (cloud)

## Setup

1. Clone the repo and install dependencies:

```bash
git clone https://github.com/matudnorthrup/openclaw-voice.git
cd openclaw-voice
npm install
```

2. Copy and fill in your environment variables:

```bash
cp .env.example .env
# Edit .env with your tokens and IDs
```

3. Configure your channels:

```bash
cp src/channels.example.json src/channels.json
# Edit src/channels.json with your Discord channel IDs and topic prompts
```

The `default` entry is required. Additional entries let you switch to topic-specific channels via voice command or `~switch`. Each entry has:
- `displayName`: Human-readable name shown in channel listings
- `channelId`: Discord channel ID where transcripts are logged (leave empty for default log channel)
- `topicPrompt`: Additional system prompt context appended to the base voice prompt (`null` for default behavior)
- `sessionKey` (optional): Custom session key for the OpenClaw gateway
- `inboxExclude` (optional): Set `true` to exclude this channel from inbox notifications

4. Build and start the bot:

```bash
npm run build
npm start
```

## Discord Bot Setup

Create a bot at the [Discord Developer Portal](https://discord.com/developers/applications).

**Required Gateway Intents** (Bot settings > Privileged Gateway Intents):
- Guilds
- Guild Voice States
- Guild Messages
- Message Content

**Required Bot Permissions**:
- Connect
- Speak
- Use Voice Activity
- Read Message History
- Send Messages

Invite the bot to your server with these permissions enabled via the OAuth2 URL generator.

## Customization

Set `BOT_NAME` in your `.env` to give the bot a custom identity. This name is used as the wake word in gated mode (e.g., "Watson, switch to health"), in the system prompt, and in transcript logging. Defaults to `Assistant` if not set.

## Voice Modes

Watson operates in one of three voice modes, which control how responses are delivered:

### Wait Mode (default)

Standard synchronous conversation. You speak, Watson processes the request, and speaks the response back. You wait for each response before speaking again. A waiting sound plays while Watson is thinking.

### Inbox Mode (queue)

Asynchronous mode. You speak and Watson dispatches your message to the LLM immediately, then plays a confirmation earcon so you can keep talking. Responses queue up in your inbox. Watson plays the *ready* earcon when responses arrive. Navigate your inbox with "next", "inbox", and "done".

Say **"inbox mode"** or **"queue mode"** to activate.

### Ask Mode

Hybrid mode. After each utterance, Watson asks "Send to inbox, or wait here?" You choose per-message:
- **"Queue"** / **"inbox"** — dispatches to inbox, you keep talking
- **"Wait"** — Watson waits for the response and reads it back
- **"Silent"** — dispatches silently, auto-reads when ready

Say **"ask mode"** to activate.

Switch back with **"wait mode"**.

## Voice Commands

Say the wake word (default: "Watson") followed by a command. In inbox/ask mode, navigation commands work without the wake word.

### Channel Navigation

| Command | Examples |
|---------|----------|
| Switch channel | "Watson, switch to health", "go to nutrition" |
| List channels | "Watson, list channels", "show channels" |
| Go to default | "Watson, default", "go home", "go back" |
| What channel | "Watson, what channel", "where am I" |
| Create forum post | "Watson, create a new post", "start a thread" |
| Dispatch to channel | "Watson, dispatch to general check the weather" |

### Mode & Gate Control

| Command | Examples |
|---------|----------|
| Switch mode | "Watson, inbox mode", "wait mode", "ask mode" |
| Enable gated mode | "Watson, gated mode", "gate on" |
| Enable open mode | "Watson, open mode", "gate off" |

### Inbox Navigation

| Command | Examples |
|---------|----------|
| Check inbox | "inbox", "what's new", "check queue" |
| Next message | "next", "done", "move on", "skip" |
| Clear inbox | "clear inbox", "mark all read" |
| Read last message | "last message", "read last message" |
| Hear full message | "hear full message", "full message" |

### Playback Control

| Command | Examples |
|---------|----------|
| Pause / stop | "pause", "stop", "be quiet", "shush" |
| Replay last response | "replay", "repeat that", "say that again" |

### Voice Tuning

| Command | Examples |
|---------|----------|
| Set silence delay | "Watson, delay 3000", "delay 500 ms" |
| Adjust delay | "Watson, longer delay", "shorter delay" |
| Set noise level | "Watson, noise high", "noise 800" |
| Show settings | "Watson, settings", "what are my settings" |

Noise presets: `low` (300), `medium` (500), `high` (800).

### Other

| Command | Examples |
|---------|----------|
| Earcon tour | "Watson, sound check", "earcon tour" |
| Silent dispatch | "silent", "wait quietly" |

## Gated vs Open Mode

- **Gated mode** (default): Watson only responds when you say the wake word first (e.g., "Watson, ..."). Unrecognized utterances get the *gate-closed* earcon. This prevents accidental triggers from background conversation.
- **Open mode**: Watson processes all speech without requiring the wake word. Useful when you're the only person in the channel.

Toggle with "Watson, gated mode" / "Watson, open mode", or `~gate on` / `~gate off` in text.

After Watson plays the *ready* earcon, there's a 5-second grace period where commands are accepted without the wake word, so you can respond naturally.

## Earcon Reference

Earcons are short synthesized audio cues that provide feedback without speech.

| Earcon | Sound | Meaning |
|--------|-------|---------|
| **listening** | Single high A5 tap | Speech detected — "I heard you" |
| **acknowledged** | Ascending G4 → C5 | Command recognized — "Got it" |
| **error** | Descending E4 → C4 | Didn't understand / failed |
| **ready** | Ascending E5 → G5 → C6 | Response ready — "Your turn!" |
| **busy** | Single low C4 hum | "I heard you but I'm busy" |
| **gate-closed** | Single soft A4 tap | Gated — wake word required |
| **timeout-warning** | Tick-tock D5/A4 pattern | Time running out on a prompt |
| **cancelled** | Three-note descent G4 → E4 → C4 | Flow ended / winding down |

Say "Watson, earcon tour" to hear all earcons demonstrated.

## Text Commands

Type these in any text channel the bot can read (use `~` prefix):

| Command | Description |
|---------|-------------|
| `~join` | Join the configured voice channel |
| `~leave` | Leave voice and stop listening |
| `~clear` | Clear conversation history for the active channel |
| `~channels` | List available topic channels |
| `~switch <name>` | Switch to a named channel (e.g., `~switch health`) |
| `~switch <id>` | Switch to any channel by Discord ID |
| `~default` | Switch back to the default channel |
| `~voice` | Show current voice detection settings |
| `~health` | Check local STT/TTS dependency status |
| `~delay <ms>` | Set silence wait time in ms (e.g., `~delay 3000`) |
| `~noise <level>` | Set noise filtering: `low`, `medium`, `high`, or a number |

## Interaction Flows Tutorial

### Basic Conversation (Wait Mode)

1. Join the voice channel (Watson auto-joins when you enter, or type `~join`).
2. Say **"Watson, what's the weather like today?"**
3. Watson plays the *listening* earcon and begins processing.
4. A waiting sound plays while the LLM generates a response.
5. Watson speaks the response, then plays the *ready* earcon.
6. You can now speak again.

### Ask Mode Workflow

1. Say **"Watson, ask mode"** — Watson confirms: "Ask mode. I will ask you whether to inbox or wait for each message."
2. Say **"Watson, what are the best exercises for back pain?"**
3. Watson immediately dispatches to the LLM, then asks: **"Send to inbox, or wait here?"**
4. Say **"wait"** — Watson plays the waiting sound until the response is ready, then speaks it.
5. Say another question: **"Watson, summarize today's news"**
6. Watson asks again: **"Send to inbox, or wait here?"**
7. Say **"queue"** — Watson confirms **"Queued to [channel]"** and you can keep talking immediately.
8. When the response arrives, Watson plays the *ready* earcon.
9. Say **"next"** to hear the queued response.

### Inbox Mode

1. Say **"Watson, inbox mode"** — Watson confirms: "Inbox mode. Your messages will be dispatched and you can keep talking."
2. Say **"Watson, how do I install Docker?"** — Watson plays *acknowledged* and dispatches immediately.
3. Say **"Watson, what's the capital of France?"** — another message dispatched.
4. Watson plays the *ready* earcon as each response arrives.
5. Say **"inbox"** — Watson reads a summary: "2 channels have new activity. Channel default: 2 responses ready."
6. Say **"next"** — Watson reads the first response.
7. Say **"next"** or **"done"** — advances to the next response.
8. Say **"hear full message"** if Watson summarized a long response and you want the complete text.
9. Say **"clear inbox"** to mark everything as read.

### Channel Switching

1. Say **"Watson, list channels"** — Watson reads available channels.
2. Say **"Watson, switch to health"** — Watson switches, loads the last 50 messages from that channel as context, and confirms.
3. Your conversation now uses the health channel's system prompt and logs transcripts there.
4. Say **"Watson, go home"** to return to the default channel.
5. You can also switch to any channel by Discord ID: **"Watson, switch to 123456789"**

### New Forum Post Creation

1. Say **"Watson, create a new post"** — Watson asks which forum and what title.
2. Follow the prompts to name the forum, provide a title, and optionally a body.
3. Watson creates the thread in Discord and auto-switches to it.

### Inbox Navigation (Detailed)

1. Say **"inbox"** or **"what's new"** — Watson summarizes unread activity across channels.
2. For 1–5 messages: Watson reads them verbatim with speaker labels.
3. For 6–15 messages: Watson reads the first 2, a count of the middle messages, and the last 2.
4. For 16+ messages: Watson gives the count and reads only the most recent.
5. Say **"hear full message"** after a summary to hear the complete response.
6. Say **"next"** to advance through responses one by one.
7. Say **"skip"** to skip the current message.

### Playback Control

1. If Watson is speaking and you want it to stop, say **"pause"** or **"stop"**.
2. If you missed something, say **"replay"** or **"repeat that"** — Watson re-reads the last response.
3. If a long response was summarized, say **"hear full message"** for the unabridged version.

### Gated vs Open Mode

1. By default, Watson is in **gated mode** — it only listens for commands preceded by the wake word.
2. Say **"Watson, open mode"** to let Watson process all speech (no wake word needed).
3. In open mode, everything you say is sent to the LLM as conversation.
4. Say **"Watson, gated mode"** to go back to requiring the wake word.

## Voice Tuning

- **`~delay <ms>`** / **"Watson, delay 3000"** — How long silence must last before speech is considered "finished." Default is 500 ms. Increase (e.g., 3000) if you pause to think mid-sentence and the bot cuts you off.
- **`~noise <low|medium|high>`** / **"Watson, noise high"** — How aggressively background noise is filtered. `low` (300) picks up softer speech, `high` (800) ignores more background noise. Default is `medium` (500). You can also pass a specific number.
- **`~voice`** / **"Watson, settings"** — Shows current settings.

Changes take effect on the next utterance. Set startup defaults via `SILENCE_DURATION_MS`, `SPEECH_THRESHOLD`, and `MIN_SPEECH_DURATION_MS` in your `.env`.

## Dependency Health

When the bot is in voice, it monitors local STT/TTS dependencies on a timer:

- If a dependency goes down, Watson logs a warning and plays the *error* earcon.
- If it recovers, a recovery message is logged.
- Query current status with `~health`.

Optional auto-restart via env vars:

- `DEPENDENCY_HEALTHCHECK_MS` (default `15000`)
- `DEPENDENCY_AUTO_RESTART=true`
- `WHISPER_RESTART_COMMAND`, `KOKORO_RESTART_COMMAND`, `CHATTERBOX_RESTART_COMMAND`

TTS failover (e.g., Kokoro -> Chatterbox):

- `TTS_BACKEND=kokoro`
- `TTS_FALLBACK_BACKEND=chatterbox`
- `TTS_PRIMARY_RETRY_MS=30000`

When primary TTS fails, Watson switches to the fallback automatically.

## Auto-Join / Auto-Leave

- The bot automatically joins the voice channel when a user enters it.
- When all users leave, the bot waits 30 seconds then disconnects.

## Automated Testing

### Interaction flow harness (deterministic, no Discord/audio required):

```bash
npm run test:flows
```

Validates AWAITING-state transitions, menu intent recognition, reprompt/error behavior, and timeout handling.

### Intent robustness matrix (STT variant testing):

```bash
npm run test:intents
```

### Flow reports:

```bash
npm run flows:report          # Quick pass/fail scenario report
npm run flows:stress          # Overlap/concurrency stress scenarios
npm run flows:stress:inbox    # Inbox-focused sequencing stress
```

### Live integration (requires Discord + Gateway):

```bash
npm run e2e:live              # Discord auth, channel routing, gateway roundtrips
npm run e2e:voice-loop        # Full voice pipeline with synthesized speech
```

Optional env knobs for live tests:
- `E2E_CHANNEL_A` (default: `default`), `E2E_CHANNEL_B` (default: `nutrition`)
- `E2E_AUDIO=false` to skip STT/TTS probe
- `E2E_SWITCH_CHANNEL_ID`, `E2E_UTILITY_CHANNEL_ID`, `E2E_FORUM_POST_ID`

## Project Structure

```
src/
  index.ts                        # Entry point, text command handling, auto-join/leave
  config.ts                       # Environment variable loading & validation
  channels.json                   # Channel definitions (gitignored, per-deployment)
  audio/
    earcons.ts                    # Earcon sound generation & synthesis
    silence-detector.ts           # Voice Activity Detection (VAD)
    waiting-sound.ts              # Looping wait tone during processing
    wav-utils.ts                  # WAV file utilities
  discord/
    client.ts                     # Discord.js client setup (intents config)
    voice-connection.ts           # Voice connection management
    audio-receiver.ts             # Captures voice audio from Discord
    audio-player.ts               # Plays TTS audio and earcons to voice channel
  pipeline/
    voice-pipeline.ts             # Main pipeline: STT → command/LLM → TTS
    pipeline-state.ts             # State machine definition
    pipeline-invariants.ts        # State validation & invariant checks
    transient-context.ts          # Ephemeral per-utterance pipeline context
    interaction-contract.ts       # Pipeline interface contracts
  prompts/
    watson-system.ts              # Base voice system prompt
  services/
    whisper.ts                    # STT backends (local Whisper / OpenAI)
    tts.ts                        # TTS backends (Kokoro / Chatterbox / ElevenLabs)
    voice-commands.ts             # Voice command parser (regex-based)
    voice-settings.ts             # Runtime-adjustable VAD/silence settings
    channel-router.ts             # Channel switching, prompt composition, history
    claude.ts                     # LLM calls via OpenClaw gateway
    queue-state.ts                # Queue/inbox mode state & persistence
    inbox-tracker.ts              # Inbox activity tracking & message filtering
    response-poller.ts            # Poll for queued LLM responses
    gateway-sync.ts               # WebSocket sync with OpenClaw text sessions
    session-transcript.ts         # JSONL session recording
    health-monitor.ts             # System health tracking & alerts
    health-snapshot.ts            # Health state snapshot
    dependency-monitor.ts         # Local service (STT/TTS) dependency monitoring
  testing/
    interaction-flow-harness.ts   # Deterministic interaction-contract simulator
    flow-report.ts                # Scenario pass/fail reporting
    stress-flow-report.ts         # Concurrency stress testing
    stress-inbox-report.ts        # Inbox sequencing stress testing
    e2e-live-report.ts            # Live Discord + Gateway integration test
    e2e-voice-loop-report.ts      # Full voice loop integration test
```

## Environment Variables

See [`.env.example`](.env.example) for the full list with descriptions.

**Required:**
- `DISCORD_TOKEN` — Discord bot token
- `DISCORD_GUILD_ID` — Discord server ID
- `DISCORD_VOICE_CHANNEL_ID` — Voice channel to join
- `GATEWAY_TOKEN` — OpenClaw gateway auth token

Plus **at least one STT backend**:
- `WHISPER_URL` — local Whisper server endpoint (e.g., `http://localhost:8178`), OR
- `OPENAI_API_KEY` — OpenAI API key for cloud Whisper

**Optional:**
- `BOT_NAME` — Bot's display name and wake word (default: `Assistant`)
- `GATEWAY_URL` — OpenClaw gateway URL (default: `http://localhost:18789`)
- `GATEWAY_AGENT_ID` — OpenClaw agent (default: `main`)
- `GATEWAY_WS_SYNC` — Enable WebSocket sync with OpenClaw text sessions (default: `true`)
- `LOG_CHANNEL_ID` — Default text channel for transcript logging
- `UTILITY_CHANNEL_ID` — Utility channel for quick completions
- `SESSIONS_DIR` — Directory for JSONL session files (default: `~/.clawdbot/agents/main/sessions`)

**TTS (at least one recommended):**
- `TTS_BACKEND` — Primary backend: `kokoro`, `chatterbox`, or `elevenlabs` (default: `elevenlabs`)
- `TTS_FALLBACK_BACKEND` — Fallback backend if primary fails
- `TTS_PRIMARY_RETRY_MS` — Retry primary after this many ms (default: `30000`)
- `KOKORO_URL` — Kokoro TTS server URL (default: `http://127.0.0.1:8880`)
- `KOKORO_VOICE` — Kokoro voice selection (default: `af_bella`)
- `CHATTERBOX_URL` — Chatterbox TTS server URL (default: `http://127.0.0.1:4123`)
- `CHATTERBOX_VOICE` — Chatterbox voice selection (default: `default`)
- `ELEVENLABS_API_KEY` — ElevenLabs API key
- `ELEVENLABS_VOICE_ID` — ElevenLabs voice ID (default: `JBFqnCBsd6RMkjVDRZzb`)

**Voice tuning:**
- `SILENCE_DURATION_MS` — Silence wait before processing speech (default: `500`)
- `SPEECH_THRESHOLD` — RMS energy noise floor (default: `500`)
- `MIN_SPEECH_DURATION_MS` — Minimum speech length to process (default: `600`)
- `EARCON_MIN_GAP_MS` — Minimum silence between earcons (default: `500`)

**Dependency monitoring:**
- `DEPENDENCY_HEALTHCHECK_MS` — Health check interval in ms (default: `15000`)
- `DEPENDENCY_AUTO_RESTART` — Auto-restart failed services (default: `false`)
- `WHISPER_RESTART_COMMAND` — Shell command to restart Whisper
- `KOKORO_RESTART_COMMAND` — Shell command to restart Kokoro
- `CHATTERBOX_RESTART_COMMAND` — Shell command to restart Chatterbox
