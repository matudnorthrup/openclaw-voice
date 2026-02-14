import type { QueueState } from './queue-state.js';
import type { GatewaySync } from './gateway-sync.js';

const POLL_INTERVAL_MS = 5_000;

export class ResponsePoller {
  private queueState: QueueState;
  private gatewaySync: GatewaySync;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private onReady: ((displayName: string) => void) | null = null;

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
      if (pending.length === 0) {
        this.stop();
        return;
      }

      for (const item of pending) {
        const result = await this.gatewaySync.getHistory(item.sessionKey, 5);
        if (!result || !result.messages) continue;

        // Look for an assistant message that appeared after we sent our user message
        const lastAssistant = [...result.messages]
          .reverse()
          .find((m) => m.role === 'assistant');

        if (lastAssistant) {
          const rawContent = lastAssistant.content;
          const content = typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? (rawContent as any[])
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n')
              : String(rawContent);

          // Generate a brief summary (first sentence or first 100 chars)
          const summary = content.length > 100
            ? content.slice(0, 100) + '...'
            : content;

          this.queueState.markReady(item.id, summary, content);
          console.log(`ResponsePoller: marked ${item.id} as ready (channel: ${item.displayName})`);
          this.onReady?.(item.displayName);
        }
      }
    } catch (err: any) {
      console.warn(`ResponsePoller poll error: ${err.message}`);
    } finally {
      this.polling = false;
    }
  }
}
