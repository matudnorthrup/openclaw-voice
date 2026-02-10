# OpenClaw Voice

A Discord voice bot for hands-free conversational AI. The bot joins a voice channel, listens via speech-to-text (Whisper), generates responses through an LLM (via OpenClaw gateway), and speaks back using text-to-speech (ElevenLabs).

## Architecture

```
Voice Input → Whisper STT → OpenClaw Gateway (LLM) → ElevenLabs TTS → Voice Output
```

- **Audio capture**: Listens to voice channel members, detects speech boundaries via silence detection
- **Speech-to-text**: OpenAI Whisper API
- **LLM**: Routes through an [OpenClaw](https://github.com/matudnorthrup/openclaw) gateway (OpenAI-compatible `/v1/chat/completions` endpoint)
- **Text-to-speech**: ElevenLabs streaming API
- **Channel routing**: Switch between topic-specific Discord channels, each with their own system prompt, conversation history, and transcript logging

## Prerequisites

- Node.js 18+
- A Discord bot with voice permissions (Connect, Speak, Use Voice Activity)
- An [OpenClaw](https://github.com/matudnorthrup/openclaw) gateway instance running locally
- OpenAI API key (for Whisper)
- ElevenLabs API key

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

The `default` entry is required. Additional entries let you `~switch` to topic-specific channels. Each entry has:
- `displayName`: Human-readable name shown in `~channels`
- `channelId`: Discord channel ID where transcripts are logged (leave empty for default log channel)
- `topicPrompt`: Additional system prompt context appended to the base voice prompt (`null` for default behavior)

4. Start the bot:

```bash
npm start
```

## Customization

Set `BOT_NAME` in your `.env` to give the bot a custom identity. This name is used in the system prompt (e.g., "You are Watson, a friendly and helpful AI assistant...") and in transcript logging. Defaults to `Assistant` if not set.

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
| `~delay <ms>` | Set silence wait time in ms (e.g., `~delay 3000` for thinking pauses) |
| `~noise <level>` | Set noise filtering: `low`, `medium`, `high`, or a number (e.g., `~noise high`) |

## Channel Switching

The bot can target different Discord channels, each with a tailored system prompt. When you switch channels:

1. The last 50 messages from that Discord channel are loaded as conversation history
2. The system prompt is composed from the base voice prompt + the channel's `topicPrompt`
3. Transcripts (your speech + the bot's replies) are logged to that channel

You can switch to **named channels** defined in `channels.json`, or to **any channel by ID** — including forum posts and threads.

## Voice Tuning

The bot's speech detection can be adjusted on the fly without restarting:

- **`~delay <ms>`** — How long silence must last before your speech is considered "finished." Default is 1500ms. Increase this (e.g., `~delay 3000`) if you pause to think mid-sentence and the bot cuts you off too early.
- **`~noise <low|medium|high>`** — How aggressively background noise is filtered. `low` (300) picks up softer speech, `high` (800) ignores more background noise. Default is `medium` (500). You can also pass a specific number, e.g., `~noise 600`.
- **`~voice`** — Shows current settings.

Changes take effect on the next utterance. Set startup defaults via `SILENCE_DURATION_MS`, `SPEECH_THRESHOLD`, and `MIN_SPEECH_DURATION_MS` in your `.env`.

## Auto-Join / Auto-Leave

- The bot automatically joins the voice channel when a user enters it
- When all users leave, the bot waits 30 seconds then disconnects

## Project Structure

```
src/
  index.ts                    # Entry point, command handling, auto-join/leave
  config.ts                   # Environment variable loading
  channels.json               # Channel definitions (gitignored, per-deployment)
  discord/
    client.ts                 # Discord.js client setup
    voice-connection.ts       # Voice connection management
    audio-receiver.ts         # Captures voice audio, silence detection
    audio-player.ts           # Plays TTS audio back to voice channel
  pipeline/
    voice-pipeline.ts         # Orchestrates STT → LLM → TTS pipeline
  services/
    whisper.ts                # OpenAI Whisper speech-to-text
    claude.ts                 # LLM calls via OpenClaw gateway
    elevenlabs.ts             # ElevenLabs text-to-speech
    channel-router.ts         # Channel switching, prompt composition, history
    voice-settings.ts         # Runtime-adjustable voice detection settings
    session-transcript.ts     # JSONL session logging
  prompts/
    watson-system.ts          # Base voice system prompt
```

## Environment Variables

See [`.env.example`](.env.example) for the full list with descriptions.

**Required:**
- `DISCORD_TOKEN` — Discord bot token
- `DISCORD_GUILD_ID` — Discord server ID
- `DISCORD_VOICE_CHANNEL_ID` — Voice channel to join
- `OPENAI_API_KEY` — For Whisper STT
- `ELEVENLABS_API_KEY` — For TTS
- `GATEWAY_URL` — OpenClaw gateway URL
- `GATEWAY_TOKEN` — OpenClaw gateway auth token

**Optional:**
- `BOT_NAME` — Bot's display name and identity (defaults to `Assistant`)
- `ELEVENLABS_VOICE_ID` — Voice to use (defaults to `JBFqnCBsd6RMkjVDRZzb`)
- `GATEWAY_AGENT_ID` — OpenClaw agent (defaults to `main`)
- `LOG_CHANNEL_ID` — Default text channel for transcript logging
- `SILENCE_DURATION_MS` — Silence wait time in ms before processing speech (defaults to `1500`)
- `SPEECH_THRESHOLD` — RMS energy threshold for speech detection (defaults to `500`)
- `MIN_SPEECH_DURATION_MS` — Minimum speech length to process (defaults to `300`)
- `SESSIONS_DIR` — Directory for JSONL session files
