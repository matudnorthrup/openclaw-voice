import { describe, it, expect } from 'vitest';
import { ResponsePoller } from '../src/services/response-poller.js';

type StubItem = {
  id: string;
  channel: string;
  displayName: string;
  sessionKey: string;
  userMessage: string;
  summary: string;
  responseText: string;
  timestamp: number;
  status: 'pending' | 'ready' | 'heard';
};

class StubQueueState {
  item: StubItem;

  constructor(item: StubItem) {
    this.item = item;
  }

  getPendingItems(): StubItem[] {
    return this.item.status === 'pending' ? [this.item] : [];
  }

  markReady(id: string, summary: string, responseText: string): void {
    if (this.item.id !== id) return;
    this.item.status = 'ready';
    this.item.summary = summary;
    this.item.responseText = responseText;
  }
}

class StubGatewaySync {
  private readonly messages: any[];

  constructor(messages: any[]) {
    this.messages = messages;
  }

  isConnected(): boolean {
    return true;
  }

  async getHistory(): Promise<{ messages: any[] }> {
    return { messages: this.messages };
  }
}

function pendingItem(ts: number): StubItem {
  return {
    id: 'q1',
    channel: 'walmart',
    displayName: 'Walmart',
    sessionKey: 'agent:main:discord:channel:1',
    userMessage: 'add milk',
    summary: '',
    responseText: '',
    timestamp: ts,
    status: 'pending',
  };
}

describe('ResponsePoller', () => {
  it('does not mark ready from stale assistant messages older than queue item', async () => {
    const queue = new StubQueueState(pendingItem(2_000));
    const gateway = new StubGatewaySync([
      { role: 'assistant', content: 'older answer', timestamp: 1_000 },
    ]);
    const poller = new ResponsePoller(queue as any, gateway as any);

    await (poller as any).poll();

    expect(queue.item.status).toBe('pending');
    expect(queue.item.responseText).toBe('');
  });

  it('does not mark ready from injected voice-user mirror messages', async () => {
    const queue = new StubQueueState(pendingItem(2_000));
    const gateway = new StubGatewaySync([
      { role: 'assistant', content: '[voice-user] add milk', timestamp: 2_100 },
    ]);
    const poller = new ResponsePoller(queue as any, gateway as any);

    await (poller as any).poll();

    expect(queue.item.status).toBe('pending');
  });

  it('marks ready from a fresh assistant response', async () => {
    const queue = new StubQueueState(pendingItem(2_000));
    const gateway = new StubGatewaySync([
      { role: 'assistant', content: '[voice-assistant] done', timestamp: 2_100 },
    ]);
    const poller = new ResponsePoller(queue as any, gateway as any);

    await (poller as any).poll();

    expect(queue.item.status).toBe('ready');
    expect(queue.item.responseText).toContain('done');
  });
});

