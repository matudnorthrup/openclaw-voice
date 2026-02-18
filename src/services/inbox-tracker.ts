import type { QueueState } from './queue-state.js';
import type { GatewaySync, ChatMessage } from './gateway-sync.js';

export interface ChannelInfo {
  name: string;
  displayName: string;
  sessionKey: string;
}

export interface ChannelActivity {
  channelName: string;
  displayName: string;
  sessionKey: string;
  newMessageCount: number;
  queuedReadyCount: number;
  newMessages: ChatMessage[];
  /** Earliest timestamp across new messages and queued ready items — used for oldest-first ordering. */
  earliestTimestamp: number;
}

export class InboxTracker {
  private queueState: QueueState;
  private gatewaySync: GatewaySync;

  constructor(queueState: QueueState, gatewaySync: GatewaySync) {
    this.queueState = queueState;
    this.gatewaySync = gatewaySync;
  }

  async activate(channels: ChannelInfo[]): Promise<void> {
    const snapshots: Record<string, number> = {};
    const now = Date.now();

    // Initialize snapshots to current time — only messages arriving AFTER
    // activation will be treated as "new".  A zero baseline would cause every
    // existing message in every channel to appear unread (ghost notifications).
    for (const ch of channels) {
      snapshots[ch.sessionKey] = now;
    }

    this.queueState.setSnapshots(snapshots);
    console.log(`InboxTracker: activated with ${Object.keys(snapshots).length} channel snapshots (baseline=${now})`);
  }

  deactivate(): void {
    this.queueState.clearSnapshots();
    console.log('InboxTracker: deactivated');
  }

  isActive(): boolean {
    return Object.keys(this.queueState.getSnapshots()).length > 0;
  }

  async checkInbox(channels: ChannelInfo[]): Promise<ChannelActivity[]> {
    const activities: ChannelActivity[] = [];

    for (const ch of channels) {
      // Re-read the snapshot for each channel inside the loop to avoid
      // clobbering concurrent markSeen() calls that may run during awaits.
      const rawBaseline = this.queueState.getSnapshots()[ch.sessionKey] ?? 0;
      const result = await this.gatewaySync.getHistory(ch.sessionKey, 80);
      // Re-read baseline AFTER the await — markSeen may have advanced it
      // while we were waiting for the network response.
      const freshBaseline = this.queueState.getSnapshots()[ch.sessionKey] ?? 0;
      const effectiveRaw = Math.max(rawBaseline, freshBaseline);

      const allMessages = result?.messages ?? [];
      const latestStamp = allMessages.length > 0
        ? this.getMessageStamp(allMessages[allMessages.length - 1], allMessages.length - 1)
        : 0;
      // Migration: snapshots that are 0 (never visited) or legacy capped message
      // counts (e.g. 40) aren't real timestamps — reset to the latest so we only
      // track genuinely new messages going forward.
      const baselineStamp = effectiveRaw < 1_000_000_000_000
        ? latestStamp
        : effectiveRaw;
      if (baselineStamp !== effectiveRaw) {
        this.advanceSnapshot(ch.sessionKey, baselineStamp);
      }
      // Only count messages labeled 'discord-user' as "new".  These represent
      // genuine human activity in Discord text channels.  Everything else is
      // either voice-originated (voice-user, voice-assistant), bot/text-agent
      // responses (discord-assistant, unlabeled gateway chat API messages), or
      // system messages — none of which should trigger inbox notifications.
      const newMessages = allMessages.filter((m, idx) =>
        this.getMessageStamp(m, idx) > baselineStamp
          && this.extractMessageLabel(m) === 'discord-user',
      );
      const newMessageCount = newMessages.length;

      // Auto-advance baseline past voice-only activity so the snapshot doesn't
      // fall behind and re-scan the same filtered-out messages every poll cycle.
      if (newMessageCount === 0 && latestStamp > baselineStamp) {
        this.advanceSnapshot(ch.sessionKey, latestStamp);
      }

      // Get queued ready items for this channel
      const readyItems = this.queueState.getReadyItems().filter((i) => i.sessionKey === ch.sessionKey);

      console.log(`InboxTracker: check ${ch.name} — snapshotStamp=${baselineStamp} latestStamp=${latestStamp} new=${newMessageCount} ready=${readyItems.length}`);

      if (newMessageCount > 0 || readyItems.length > 0) {
        // Compute earliest timestamp for oldest-first ordering.
        const timestamps: number[] = [];
        for (const m of newMessages) {
          const ts = this.getMessageStamp(m as ChatMessage & { timestamp?: number }, 0);
          if (ts > 0) timestamps.push(ts);
        }
        for (const item of readyItems) {
          if (item.timestamp > 0) timestamps.push(item.timestamp);
        }
        const earliestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : Infinity;

        activities.push({
          channelName: ch.name,
          displayName: ch.displayName,
          sessionKey: ch.sessionKey,
          newMessageCount,
          queuedReadyCount: readyItems.length,
          newMessages,
          earliestTimestamp,
        });
      }
    }

    // Sort oldest-first so "next" reads the earliest activity first.
    activities.sort((a, b) => a.earliestTimestamp - b.earliestTimestamp);

    return activities;
  }

  markSeen(sessionKey: string, count: number): void {
    this.advanceSnapshot(sessionKey, count);
  }

  /**
   * Advance a single channel's snapshot forward (never backwards).
   * Uses read-modify-write on the full snapshots object but only moves
   * the value forward, so concurrent calls cannot regress each other.
   */
  private advanceSnapshot(sessionKey: string, stamp: number): void {
    const snapshots = this.queueState.getSnapshots();
    const current = snapshots[sessionKey] ?? 0;
    if (stamp > current) {
      snapshots[sessionKey] = stamp;
      this.queueState.setSnapshots(snapshots);
    }
  }

  formatForTTS(newMessages: ChatMessage[]): string {
    if (newMessages.length === 0) return '';

    // Filter to user/assistant messages with content
    const msgs = newMessages
      .filter((m) => m.role !== 'system' && m.content)
      .map((m) => ({ message: m, text: this.extractSpeechText(m.content) }))
      .filter((m) => m.text.length > 0);

    if (msgs.length === 0) return '';

    if (msgs.length <= 5) {
      // Verbatim with speaker labels
      return msgs.map((m) => {
        const speaker = m.message.role === 'user' ? 'User' : 'Assistant';
        const label = m.message.label === 'voice-user' ? 'You' : speaker;
        const content = m.text;
        return `${label}: ${content}`;
      }).join(' ... ');
    }

    if (msgs.length <= 15) {
      // Condensed: first 2 + "N more" + last 2
      const first = msgs.slice(0, 2).map((m) => {
        const speaker = m.message.role === 'user' ? 'User' : 'Assistant';
        const label = m.message.label === 'voice-user' ? 'You' : speaker;
        const content = m.text;
        return `${label}: ${content}`;
      }).join(' ... ');

      const last = msgs.slice(-2).map((m) => {
        const speaker = m.message.role === 'user' ? 'User' : 'Assistant';
        const label = m.message.label === 'voice-user' ? 'You' : speaker;
        const content = m.text;
        return `${label}: ${content}`;
      }).join(' ... ');

      const skipped = msgs.length - 4;
      return `${first} ... ${skipped} more messages ... ${last}`;
    }

    // 16+ messages: just count + most recent
    const lastMsg = msgs[msgs.length - 1];
    const speaker = lastMsg.message.role === 'user' ? 'User' : 'Assistant';
    const label = lastMsg.message.label === 'voice-user' ? 'You' : speaker;
    const content = lastMsg.text;
    return `${msgs.length} messages. Most recent, ${label}: ${content}`;
  }

  private async getMessageCount(sessionKey: string): Promise<number> {
    if (!this.gatewaySync.isConnected()) return 0;
    const result = await this.gatewaySync.getHistory(sessionKey, 80);
    const messages = result?.messages ?? [];
    if (messages.length === 0) return 0;
    return this.getMessageStamp(messages[messages.length - 1], messages.length - 1);
  }

  private getMessageStamp(message: ChatMessage & { timestamp?: number }, fallbackIndex: number): number {
    const ts = (message as any)?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      return ts;
    }
    // Fallback keeps stable ordering even when timestamp is absent.
    return fallbackIndex + 1;
  }

  private extractSpeechText(content: unknown): string {
    if (typeof content === 'string') {
      return this.cleanSpeechText(content);
    }
    if (Array.isArray(content)) {
      const joined = content
        .map((block: any) => {
          if (!block || typeof block !== 'object') return '';
          if (block.type === 'text' && typeof block.text === 'string') return block.text;
          if (typeof block.text === 'string') return block.text;
          if (typeof block.content === 'string') return block.content;
          return '';
        })
        .filter(Boolean)
        .join(' ')
        .trim();
      return this.cleanSpeechText(joined);
    }
    if (content && typeof content === 'object') {
      const c: any = content;
      if (typeof c.text === 'string') return this.cleanSpeechText(c.text);
      if (typeof c.content === 'string') return this.cleanSpeechText(c.content);
    }
    return '';
  }

  /**
   * Extract the label from a gateway message.  The gateway stores labels as a
   * text prefix `[label]\n\n` inside the message content rather than a separate
   * field.  Check the `label` property first (future-proofing) then fall back
   * to parsing the prefix.
   */
  private extractMessageLabel(message: ChatMessage): string | undefined {
    // Check for an explicit label property first (future-proof)
    if ((message as any).label) return (message as any).label;

    const text = this.extractSpeechText(message.content);
    const match = text.match(/^\[([a-z][\w-]*)\]/i);
    return match ? match[1] : undefined;
  }

  private cleanSpeechText(text: string): string {
    return text
      .replace(/^\[(?:discord-user|discord-assistant)\]\s*/i, '')
      .replace(/^\*\*You:\*\*\s*/i, '')
      .replace(/^\*\*Watson(?: Voice)?:\*\*\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
