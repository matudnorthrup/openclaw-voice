# Inbox as Mission Control

**Status:** Core flows implemented, polish in progress
**Source:** Watson Voice Obsidian thread (2026-02-15)

## Vision

The inbox is a **home base** — an orchestration layer where you sit, dispatch work to channels, and get notified as responses arrive. It's not a transient check; it's a place you inhabit.

## Core UX

- **At inbox:** Silence by default. Nudges when responses arrive ("General is ready."). You decide when to listen.
- **Diving into a channel:** "Go to general" → hear response → reply → auto-return to inbox (in inbox mode).
- **Dispatch from inbox:** "Watson, dispatch to nutrition: I had eggs" → message fires, you stay at inbox.

## Modes

| Mode | After speaking | Inbox behavior |
|------|---------------|----------------|
| Wait | Stay in channel | Inbox is explicit choice |
| Inbox | Auto-return to inbox | Inbox is home base |
| Ask | Prompt per-message | "Inbox" choice goes to home base |

## Implementation Phases

1. ✅ Inbox as persistent state (`INBOX_HOME`)
2. ✅ Proactive nudges (response poller → TTS notification)
3. ✅ Auto-return from channels
4. 🔄 Polish (pending status, cancel dispatch, entry summary)

## Key Decisions

- Nudges are notifications, not auto-reads
- `returnChannel` tracks where user came from for auto-return
- Flow list caches channel IDs but content is fetched live (no staleness problem)
- Language: "Dispatched to X" not "Queued to X"
