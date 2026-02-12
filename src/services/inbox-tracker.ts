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

    for (const ch of channels) {
      const count = await this.getMessageCount(ch.sessionKey);
      snapshots[ch.sessionKey] = count;
    }

    this.queueState.setSnapshots(snapshots);
    console.log(`InboxTracker: activated with ${Object.keys(snapshots).length} channel snapshots`);
  }

  deactivate(): void {
    this.queueState.clearSnapshots();
    console.log('InboxTracker: deactivated');
  }

  isActive(): boolean {
    return Object.keys(this.queueState.getSnapshots()).length > 0;
  }

  async checkInbox(channels: ChannelInfo[]): Promise<ChannelActivity[]> {
    const snapshots = this.queueState.getSnapshots();
    const activities: ChannelActivity[] = [];

    for (const ch of channels) {
      const baselineCount = snapshots[ch.sessionKey] ?? 0;
      const result = await this.gatewaySync.getHistory(ch.sessionKey, 40);
      const currentCount = result?.messages?.length ?? 0;
      const newMessageCount = Math.max(0, currentCount - baselineCount);

      // Get queued ready items for this channel
      const readyItems = this.queueState.getReadyItems().filter((i) => i.sessionKey === ch.sessionKey);

      if (newMessageCount > 0 || readyItems.length > 0) {
        // Extract new messages (the ones beyond the snapshot)
        const allMessages = result?.messages ?? [];
        const newMessages = newMessageCount > 0
          ? allMessages.slice(baselineCount)
          : [];

        activities.push({
          channelName: ch.name,
          displayName: ch.displayName,
          sessionKey: ch.sessionKey,
          newMessageCount,
          queuedReadyCount: readyItems.length,
          newMessages,
        });
      }
    }

    return activities;
  }

  markSeen(sessionKey: string, count: number): void {
    const snapshots = this.queueState.getSnapshots();
    snapshots[sessionKey] = count;
    this.queueState.setSnapshots(snapshots);
  }

  formatForTTS(newMessages: ChatMessage[]): string {
    if (newMessages.length === 0) return '';

    // Filter to user/assistant messages with content
    const msgs = newMessages.filter((m) => m.role !== 'system' && m.content);

    if (msgs.length === 0) return '';

    if (msgs.length <= 5) {
      // Verbatim with speaker labels
      return msgs.map((m) => {
        const speaker = m.role === 'user' ? 'User' : 'Assistant';
        const label = m.label === 'voice-user' ? 'You' : speaker;
        const content = typeof m.content === 'string' ? m.content : String(m.content);
        return `${label}: ${content}`;
      }).join(' ... ');
    }

    if (msgs.length <= 15) {
      // Condensed: first 2 + "N more" + last 2
      const first = msgs.slice(0, 2).map((m) => {
        const speaker = m.role === 'user' ? 'User' : 'Assistant';
        const label = m.label === 'voice-user' ? 'You' : speaker;
        const content = typeof m.content === 'string' ? m.content : String(m.content);
        return `${label}: ${content}`;
      }).join(' ... ');

      const last = msgs.slice(-2).map((m) => {
        const speaker = m.role === 'user' ? 'User' : 'Assistant';
        const label = m.label === 'voice-user' ? 'You' : speaker;
        const content = typeof m.content === 'string' ? m.content : String(m.content);
        return `${label}: ${content}`;
      }).join(' ... ');

      const skipped = msgs.length - 4;
      return `${first} ... ${skipped} more messages ... ${last}`;
    }

    // 16+ messages: just count + most recent
    const lastMsg = msgs[msgs.length - 1];
    const speaker = lastMsg.role === 'user' ? 'User' : 'Assistant';
    const label = lastMsg.label === 'voice-user' ? 'You' : speaker;
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : String(lastMsg.content);
    return `${msgs.length} messages. Most recent, ${label}: ${content}`;
  }

  private async getMessageCount(sessionKey: string): Promise<number> {
    if (!this.gatewaySync.isConnected()) return 0;
    const result = await this.gatewaySync.getHistory(sessionKey, 40);
    return result?.messages?.length ?? 0;
  }
}
