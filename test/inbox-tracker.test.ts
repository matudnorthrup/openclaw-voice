import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InboxTracker, type ChannelInfo } from '../src/services/inbox-tracker.js';
import type { ChatMessage } from '../src/services/gateway-sync.js';

// Minimal mock for QueueState
function createMockQueueState() {
  let snapshots: Record<string, number> = {};
  let readyItems: any[] = [];
  return {
    getSnapshots: () => ({ ...snapshots }),
    setSnapshots: (s: Record<string, number>) => { snapshots = { ...s }; },
    clearSnapshots: () => { snapshots = {}; },
    getReadyItems: () => readyItems,
    _setReadyItems: (items: any[]) => { readyItems = items; },
    _getInternalSnapshots: () => snapshots,
  };
}

// Minimal mock for GatewaySync
function createMockGatewaySync(historyMap: Record<string, ChatMessage[]> = {}) {
  return {
    isConnected: () => true,
    getHistory: async (sessionKey: string, _limit?: number) => {
      const messages = historyMap[sessionKey] ?? [];
      return { messages };
    },
  };
}

const testChannels: ChannelInfo[] = [
  { name: 'health', displayName: 'Health', sessionKey: 'session:health' },
  { name: 'finance', displayName: 'Finance', sessionKey: 'session:finance' },
  { name: 'planning', displayName: 'Planning', sessionKey: 'session:planning' },
];

describe('InboxTracker', () => {
  describe('activate / deactivate / isActive', () => {
    it('activates and snapshots all channels', async () => {
      const historyMap: Record<string, ChatMessage[]> = {
        'session:health': [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        'session:finance': [
          { role: 'user', content: 'budget' },
        ],
        'session:planning': [],
      };

      const qs = createMockQueueState();
      const gs = createMockGatewaySync(historyMap);
      const tracker = new InboxTracker(qs as any, gs as any);

      await tracker.activate(testChannels);

      expect(tracker.isActive()).toBe(true);
      const snapshots = qs.getSnapshots();
      expect(snapshots['session:health']).toBe(2);
      expect(snapshots['session:finance']).toBe(1);
      expect(snapshots['session:planning']).toBe(0);
    });

    it('deactivates and clears snapshots', async () => {
      const qs = createMockQueueState();
      const gs = createMockGatewaySync({});
      const tracker = new InboxTracker(qs as any, gs as any);

      await tracker.activate(testChannels);
      expect(tracker.isActive()).toBe(true);

      tracker.deactivate();
      expect(tracker.isActive()).toBe(false);
      expect(qs.getSnapshots()).toEqual({});
    });
  });

  describe('checkInbox', () => {
    it('returns channels with new activity', async () => {
      const qs = createMockQueueState();
      // Set baseline snapshots
      qs.setSnapshots({
        'session:health': 2,
        'session:finance': 1,
        'session:planning': 0,
      });

      // Health now has 4 messages (2 new), finance still 1, planning still 0
      const historyMap: Record<string, ChatMessage[]> = {
        'session:health': [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'new msg 1' },
          { role: 'assistant', content: 'new msg 2' },
        ],
        'session:finance': [
          { role: 'user', content: 'budget' },
        ],
        'session:planning': [],
      };

      const gs = createMockGatewaySync(historyMap);
      const tracker = new InboxTracker(qs as any, gs as any);

      const activities = await tracker.checkInbox(testChannels);

      expect(activities).toHaveLength(1);
      expect(activities[0].channelName).toBe('health');
      expect(activities[0].newMessageCount).toBe(2);
      expect(activities[0].newMessages).toHaveLength(2);
      expect(activities[0].newMessages[0].content).toBe('new msg 1');
    });

    it('includes channels with queued ready items', async () => {
      const qs = createMockQueueState();
      qs.setSnapshots({
        'session:health': 2,
        'session:finance': 1,
        'session:planning': 0,
      });
      qs._setReadyItems([
        { id: '1', sessionKey: 'session:finance', status: 'ready', displayName: 'Finance' },
      ]);

      const historyMap: Record<string, ChatMessage[]> = {
        'session:health': [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        'session:finance': [
          { role: 'user', content: 'budget' },
        ],
        'session:planning': [],
      };

      const gs = createMockGatewaySync(historyMap);
      const tracker = new InboxTracker(qs as any, gs as any);

      const activities = await tracker.checkInbox(testChannels);

      expect(activities).toHaveLength(1);
      expect(activities[0].channelName).toBe('finance');
      expect(activities[0].queuedReadyCount).toBe(1);
      expect(activities[0].newMessageCount).toBe(0);
    });

    it('returns empty when no new activity', async () => {
      const qs = createMockQueueState();
      qs.setSnapshots({
        'session:health': 2,
        'session:finance': 1,
        'session:planning': 0,
      });

      const historyMap: Record<string, ChatMessage[]> = {
        'session:health': [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        'session:finance': [
          { role: 'user', content: 'budget' },
        ],
        'session:planning': [],
      };

      const gs = createMockGatewaySync(historyMap);
      const tracker = new InboxTracker(qs as any, gs as any);

      const activities = await tracker.checkInbox(testChannels);
      expect(activities).toHaveLength(0);
    });
  });

  describe('markSeen', () => {
    it('updates the snapshot for a channel', () => {
      const qs = createMockQueueState();
      qs.setSnapshots({ 'session:health': 2, 'session:finance': 1 });

      const gs = createMockGatewaySync();
      const tracker = new InboxTracker(qs as any, gs as any);

      tracker.markSeen('session:health', 5);

      const snapshots = qs.getSnapshots();
      expect(snapshots['session:health']).toBe(5);
      expect(snapshots['session:finance']).toBe(1);
    });
  });

  describe('formatForTTS', () => {
    it('returns empty string for no messages', () => {
      const qs = createMockQueueState();
      const gs = createMockGatewaySync();
      const tracker = new InboxTracker(qs as any, gs as any);

      expect(tracker.formatForTTS([])).toBe('');
    });

    it('reads 1-5 messages verbatim with speaker labels', () => {
      const qs = createMockQueueState();
      const gs = createMockGatewaySync();
      const tracker = new InboxTracker(qs as any, gs as any);

      const msgs: ChatMessage[] = [
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'I am fine.' },
      ];

      const result = tracker.formatForTTS(msgs);
      expect(result).toContain('User: How are you?');
      expect(result).toContain('Assistant: I am fine.');
    });

    it('labels voice-user messages as "You"', () => {
      const qs = createMockQueueState();
      const gs = createMockGatewaySync();
      const tracker = new InboxTracker(qs as any, gs as any);

      const msgs: ChatMessage[] = [
        { role: 'user', content: 'My voice message', label: 'voice-user' },
        { role: 'assistant', content: 'Response' },
      ];

      const result = tracker.formatForTTS(msgs);
      expect(result).toContain('You: My voice message');
    });

    it('condenses 6-15 messages (first 2 + count + last 2)', () => {
      const qs = createMockQueueState();
      const gs = createMockGatewaySync();
      const tracker = new InboxTracker(qs as any, gs as any);

      const msgs: ChatMessage[] = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Message ${i + 1}`,
      }));

      const result = tracker.formatForTTS(msgs);
      expect(result).toContain('User: Message 1');
      expect(result).toContain('Assistant: Message 2');
      expect(result).toContain('4 more messages');
      expect(result).toContain('User: Message 7');
      expect(result).toContain('Assistant: Message 8');
    });

    it('shows count + most recent for 16+ messages', () => {
      const qs = createMockQueueState();
      const gs = createMockGatewaySync();
      const tracker = new InboxTracker(qs as any, gs as any);

      const msgs: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Message ${i + 1}`,
      }));

      const result = tracker.formatForTTS(msgs);
      expect(result).toContain('20 messages');
      expect(result).toContain('Most recent');
      expect(result).toContain('Message 20');
    });

    it('skips system messages', () => {
      const qs = createMockQueueState();
      const gs = createMockGatewaySync();
      const tracker = new InboxTracker(qs as any, gs as any);

      const msgs: ChatMessage[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hello' },
      ];

      const result = tracker.formatForTTS(msgs);
      expect(result).not.toContain('System');
      expect(result).toContain('User: Hello');
    });
  });
});
