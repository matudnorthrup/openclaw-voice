# Known Issues

## Active

### Text/Audio Session Sync Drift
**Status:** investigating | **Component:** gateway-sync, channel-router, pipeline, claude
**Impact:** High — voice and text sessions can get out of alignment, causing Watson to lose context or respond with stale history.

Latest confirmed incident (2026-02-28): in `#general` (`1469108546351140896`), assistant posts can include embedded `[voice-user]` transcript blocks, which appears as user-message replay in channel logs.

See `debugging/audio-text-sync.md` for the full investigation journal and incident details.

### Node Version Constraints
**Status:** workaround in place
**Impact:** Medium — must use Node 22 for runtime.
- Node 24: fails loading `@discordjs/opus` native binary
- Node 18: lacks global `WebSocket`, disables gateway sync
- **Workaround:** Pin to Node 22 in tmux start command: `/opt/homebrew/opt/node@22/bin/node dist/index.js`

## Resolved

*(Move issues here when fixed, with date and commit/PR reference)*
