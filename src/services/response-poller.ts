import type { QueueState } from './queue-state.js';
import type { GatewaySync } from './gateway-sync.js';

const POLL_INTERVAL_MS = 5_000;
const STABLE_ASSISTANT_POLLS_REQUIRED = 2;

type PendingObservation = {
  signature: string;
  stablePolls: number;
};

export class ResponsePoller {
  private queueState: QueueState;
  private gatewaySync: GatewaySync;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private onReady: ((displayName: string) => void) | null = null;
  private pendingObservations = new Map<string, PendingObservation>();

  constructor(queueState: QueueState, gatewaySync: GatewaySync) {
    this.queueState = queueState;
    this.gatewaySync = gatewaySync;
  }

  setOnReady(callback: (displayName: string) => void): void {
    this.onReady = callback;
  }

  start(): void {
    if (this.timer) return;

    // Only start if there are pending items (restart recovery)
    if (this.queueState.getPendingItems().length === 0) return;

    console.log('ResponsePoller: starting (pending items detected from previous session)');
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('ResponsePoller: stopped');
    }
  }

  /** Call after enqueue/markReady to auto-start/stop as needed */
  check(): void {
    const pendingCount = this.queueState.getPendingItems().length;
    if (pendingCount > 0 && !this.timer) {
      this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    } else if (pendingCount === 0 && this.timer) {
      this.stop();
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.gatewaySync.isConnected()) return;
    this.polling = true;

    try {
      const pending = this.queueState.getPendingItems();
      const pendingIds = new Set(pending.map((p) => p.id));
      for (const id of this.pendingObservations.keys()) {
        if (!pendingIds.has(id)) this.pendingObservations.delete(id);
      }
      if (pending.length === 0) {
        this.stop();
        return;
      }

      for (const item of pending) {
        const result = await this.gatewaySync.getHistory(item.sessionKey, 40);
        if (!result || !result.messages) continue;

        // Consider only messages at/after queue time when timestamps are available.
        const freshMessages = result.messages.filter((m: any) => {
          const ts = this.getMessageTimestamp(m);
          return ts === null || ts >= item.timestamp;
        });

        const assistants = freshMessages
          .filter((m: any) => m.role === 'assistant')
          .map((m: any) => {
            const text = this.toText(m.content).trim();
            return { message: m, text };
          })
          .filter(({ text }) => {
            if (!text) return false;
            // Skip injected user mirrors ("[voice-user] ..."), which are not replies.
            if (text.toLowerCase().startsWith('[voice-user]')) return false;
            return true;
          });

        if (assistants.length === 0) continue;

        const lastAssistant = assistants[assistants.length - 1]!;
        const lastAssistantTs = this.getMessageTimestamp(lastAssistant.message);

        // If there is newer non-empty activity after the current assistant tail,
        // keep waiting for the response to settle.
        const hasNewerActivity = freshMessages.some((m: any) => {
          const ts = this.getMessageTimestamp(m);
          if (ts === null || lastAssistantTs === null) return false;
          if (ts <= lastAssistantTs) return false;
          const text = this.toText(m.content).trim();
          return text.length > 0;
        });
        if (hasNewerActivity) {
          this.pendingObservations.delete(item.id);
          continue;
        }

        const signature = `${lastAssistantTs ?? 'no-ts'}:${lastAssistant.text.slice(0, 300)}`;
        const previous = this.pendingObservations.get(item.id);
        if (!previous || previous.signature !== signature) {
          this.pendingObservations.set(item.id, { signature, stablePolls: 1 });
          continue;
        }

        const stablePolls = previous.stablePolls + 1;
        this.pendingObservations.set(item.id, { signature, stablePolls });
        if (stablePolls < STABLE_ASSISTANT_POLLS_REQUIRED) continue;

        const content = assistants.map((a) => a.text).join('\n\n');

        // Generate a brief summary (first sentence or first 100 chars)
        const summary = content.length > 100
          ? content.slice(0, 100) + '...'
          : content;

        this.queueState.markReady(item.id, summary, content);
        this.pendingObservations.delete(item.id);
        console.log(`ResponsePoller: marked ${item.id} as ready (channel: ${item.displayName})`);
        this.onReady?.(item.displayName);
      }
    } catch (err: any) {
      console.warn(`ResponsePoller poll error: ${err.message}`);
    } finally {
      this.polling = false;
    }
  }

  private getMessageTimestamp(message: any): number | null {
    const value = message?.timestamp;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private toText(rawContent: unknown): string {
    if (typeof rawContent === 'string') return rawContent;
    if (Array.isArray(rawContent)) {
      return (rawContent as any[])
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
    }
    if (rawContent == null) return '';
    return String(rawContent);
  }
}
