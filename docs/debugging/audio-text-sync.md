---
status: investigating
component: gateway-sync, channel-router, pipeline
priority: high
started: 2026-02-01
tags: [audio, sync, gateway, sessions, context-drift]
---

# Audio/Text Session Sync Investigation

**Problem:** Voice and text sessions drift out of alignment. Watson Voice injects transcripts into OpenClaw gateway sessions, but the two can get out of sync — causing Watson to lose context, respond with stale history, or miss messages from one side.

**Why it matters:** This is the core integration between Watson Voice (audio) and Watson/OpenClaw (text). When sync breaks, the conversational experience degrades significantly.

## System Overview

Voice ↔ Text sync works via `gateway-sync.ts`:
1. Watson Voice connects to OpenClaw Gateway via WebSocket
2. Voice transcripts are injected into gateway sessions via `chat.inject`
3. Channel switches load history from gateway via `chat.history`
4. Session keys are discovered/cached per Discord channel

Key files:
- `src/services/gateway-sync.ts` — WebSocket connection, inject, history fetch
- `src/services/channel-router.ts` — channel switching, session key management
- `src/pipeline/voice-pipeline.ts` — orchestration, when inject happens

## Investigation Log

### 2026-02-24 — Journal Created
- **Action:** Created this debugging journal to track the ongoing sync investigation
- **Context:** Multiple sessions of debugging have occurred but findings were scattered across Obsidian threads and chat history. Consolidating here for AI agent access.
- **Known symptoms:**
  - Voice and text context can diverge after channel switches
  - Session key cache can become stale
  - History loading on channel switch sometimes pulls wrong/incomplete context
- **Previous fixes applied:**
  - Session key cache invalidation on "session not found" errors (commit `a876ff5`)
  - Proactive session key cache refresh every 5 min (commit `2403b9b`)
  - Prefer shortest discovered session key to avoid key conflicts
- **Next:** Need to systematically document reproduction steps and map exactly where sync breaks down

### 2026-02-24 — Root Cause (Current Best Explanation)
- **Observed behavior:** split families exist for the same Discord channel (`agent:main:discord:channel:<id>` plus one or more `agent:main:openai-user:...` aliases).  
- **Failure mode:** injects can be delivered to an alias key, but sibling mirroring/exclusion logic was not always excluding the actual delivered key. This let canonical and alias histories diverge over time.
- **Why previous fixes were insufficient:** cache refresh + invalidation reduced stale-key failures, but did not guarantee canonical/alias sibling parity after each inject.

### 2026-02-24 — Code Fixes Applied
- `src/services/gateway-sync.ts`
  - `inject()` now returns `{ messageId, sessionKey }` (actual delivered key).
  - Mirror exclusion now uses exact delivered key identity instead of normalized variants.
- `src/index.ts` and `src/pipeline/voice-pipeline.ts`
  - Text/voice sync paths now mirror with `excludeSessionKeys: [injected.sessionKey]`.
  - Added delivered-key logging in success paths.
- `src/testing/backfill-session-splits.ts`
  - Backfill mirroring exclusion aligned to delivered key.
- `test/gateway-sync.test.ts`
  - Added regression test: delivery to alias still mirrors to canonical sibling.

### 2026-02-24 — Incident: "Laumua integration"
- **Discord thread/channel ID:** `1475876826562691072`
- **Symptom:** text bot history lacked voice-side context from the same conversation.
- **Repair command run:**
  - `npm run -s session:backfill -- --channel=1475876826562691072 --history-limit=400 --max-per-channel=200`
- **Result at repair time:** `injectedCanonical=6 mirrored=6 failed=0`
- **Current verification (latest):**
  - `session:backfill --dry-run ...` reports `missing=0`
  - `session:health --channel=1475876826562691072` reports `canonicalCoverage=1.00 status=OK`

### 2026-02-24 — Incident: "Documentation"
- **Discord thread/channel ID:** `1475957627493023894`
- **Pre-repair dry run:**
  - `npm run -s session:backfill -- --dry-run --channel=1475957627493023894 --history-limit=500 --max-per-channel=300`
  - Reported `missing=6 applying=6`
- **Repair command run:**
  - `npm run -s session:backfill -- --channel=1475957627493023894 --history-limit=500 --max-per-channel=300`
- **Result at repair time:** `injectedCanonical=6 mirrored=6 failed=0`
- **Current verification (latest):**
  - `session:backfill --dry-run ...` reports `missing=0`
  - `session:health --channel=1475957627493023894` reports `canonicalCoverage=1.00 status=OK`

### 2026-02-24 — Operational Reliability Findings
- **Bot offline event:** `watson-voice` tmux session existed, but bot process was not running (shell prompt in pane).
- **Runtime constraints discovered:**
  - Node 24 can fail Opus native load in this environment (`@discordjs/opus` binary mismatch).
  - Node 18 runs voice but disables gateway sync (`WebSocket is not defined`).
  - **Pinned runtime:** Node 22 (`/opt/homebrew/opt/node@22/bin/node dist/index.js`).

### 2026-02-24 — New Repair Command Added
- Added one-shot thread repair helper:
  - `npm run -s session:repair-thread -- --thread='Documentation'`
  - or `npm run -s session:repair-thread -- --channel=<discordChannelId>`
  - add `--dry-run` to preview.
- Script path: `src/testing/repair-thread-session.ts`
- Purpose: preflight coverage/missing, apply backfill, then verify in one command.

### 2026-02-28 — Incident: "General channel user-message replay"
- **Discord thread/channel ID:** `1469108546351140896` (`#general`)
- **Detection signal:**
  - User report: "my message is captured, then assistant message, then my message again"
  - Discord evidence: message `1477393401522421984` contains assistant text plus embedded `[voice-user]` and `[voice-assistant]` blocks in a single assistant post
- **Runtime evidence gathered:**
  - `watson-voice` logs for queue item `7f887d35-e460-4478-bf97-855ed48ba11a` show one `voice-user` inject and one `voice-assistant` inject (each mirrored to siblings)
  - canonical gateway history includes assistant messages with embedded transcript markers, including `[voice-user]` not at message start
  - `npm run -s session:health -- --channel=1469108546351140896 --history-limit=300`:
    - `canonicalCoverage=1.00 status=OK` (split still present; coverage not missing)
  - `npm run -s session:backfill -- --dry-run --channel=1469108546351140896 --history-limit=500 --max-per-channel=300`:
    - `missing=0 applying=0`
- **Root cause hypothesis (updated):**
  - This incident is not primarily a "missing mirror/backfill" problem.
  - Assistant payload contamination is leaking into user-facing output:
    - `src/services/claude.ts` strips only `[Current message - respond to this]` tails.
    - It does not sanitize assistant responses that include embedded `[voice-user]` / `[voice-assistant]` transcript blocks.
    - `src/pipeline/voice-pipeline.ts` logs the returned assistant text directly to Discord, so contaminated payloads are posted verbatim.
  - `src/services/channel-router.ts` currently keeps unlabeled gateway `user`/`assistant` history entries as-is, including metadata wrappers like `[Chat messages since your last reply - for context]`, which can further pollute subsequent prompts.
- **Relationship to earlier split-family RCA:**
  - Prior delivered-key mirror exclusion fix still appears valid.
  - Session split remains active (family depth up to 4+ in general), which increases complexity/noise but did not explain this specific replay symptom by itself.
- **Follow-up tasks:**
  - Add stricter assistant-output sanitizer in `claude.ts` for transcript/label artifacts.
  - Add a defensive pre-log sanitizer in `voice-pipeline.ts` before Discord/TTS output.
  - Filter metadata wrapper turns during OpenClaw history seed in `channel-router.ts`.
  - Add regression tests for assistant payloads containing embedded `[voice-user]` blocks.

## Current Runbook

1. Detect split/coverage issues:
   - `npm run -s session:health`
2. Repair a specific thread quickly:
   - `npm run -s session:repair-thread -- --thread='<thread name>'`
3. Verify repair:
   - `npm run -s session:backfill -- --dry-run --channel=<id>`
   - `npm run -s session:health -- --channel=<id>`
4. Ensure runtime is healthy:
   - Run bot in tmux with Node 22 command above.
5. Persist observability snapshots to Atlas:
   - `npm run -s session:health:atlas`
6. Dry-run auto-repair candidate selection:
   - `npm run -s session:auto-repair -- --dry-run`

## Open Questions / Follow-up

- Add scheduled health check + alerting on `session:health` non-zero exit.
- Consider auto-heal hook when split warning (`Gateway session split detected ...`) appears repeatedly for a channel.
- Atlas observability now available via:
  - `session_health_snapshots`
  - `session_family_members`
  - `session_repair_events`
- Add alerting/snapshot query for assistant payload contamination markers:
  - `\[voice-user\]` or `\[chat messages since your last reply` appearing inside assistant message bodies
- Investigate occasional gateway write failure observed in logs:
  - `RPC error UNAVAILABLE: failed to write transcript: transcript file not found`
  - This may be a separate gateway-side persistence issue that can trigger fresh drift.

## Incident Entry Template

Copy this block for each new sync incident:

```
### YYYY-MM-DD — Incident: "<thread name>"
- **Discord thread/channel ID:** `<id>`
- **Detection signal:**
  - (example) `Gateway session split detected channel=<id> sessions=<n>`
  - (example) User report: "voice bot/text bot context differs"
- **Pre-repair state:**
  - `npm run -s session:backfill -- --dry-run --channel=<id> --history-limit=500 --max-per-channel=300`
  - Output summary: `missing=<n> applying=<n>`
- **Repair action:**
  - `npm run -s session:repair-thread -- --channel=<id>`
  - or `npm run -s session:backfill -- --channel=<id> --history-limit=500 --max-per-channel=300`
- **Repair result:**
  - Output summary: `injectedCanonical=<n> mirrored=<n> failed=<n>`
- **Post-repair verification:**
  - `npm run -s session:backfill -- --dry-run --channel=<id> --history-limit=500 --max-per-channel=300`
  - Expected: `missing=0`
  - `npm run -s session:health -- --channel=<id> --history-limit=500`
  - Expected: `canonicalCoverage=1.00 status=OK`
- **Root cause hypothesis:** `<what likely happened>`
- **Code/runtime changes made:** `<files or commands>`
- **Follow-up tasks:** `<alerts, monitoring, prevention>`
```
