import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QueueState } from '../src/services/queue-state.js';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const STATE_PATH = resolve(process.env['HOME']!, 'clawd/voice-queue-state.json');

describe('QueueState', () => {
  let state: QueueState;

  beforeEach(() => {
    // Clean slate
    try { unlinkSync(STATE_PATH); } catch {}
    state = new QueueState();
  });

  afterEach(() => {
    try { unlinkSync(STATE_PATH); } catch {}
  });

  it('defaults to wait mode', () => {
    expect(state.getMode()).toBe('wait');
  });

  it('sets and persists mode', () => {
    state.setMode('queue');
    expect(state.getMode()).toBe('queue');

    // Reload from disk
    const state2 = new QueueState();
    expect(state2.getMode()).toBe('queue');
  });

  it('enqueues an item with pending status', () => {
    const item = state.enqueue({
      channel: 'nutrition',
      displayName: 'Nutrition',
      sessionKey: 'agent:main:discord:channel:123',
      userMessage: 'How many calories in an avocado?',
    });

    expect(item.status).toBe('pending');
    expect(item.channel).toBe('nutrition');
    expect(item.id).toBeTruthy();
    expect(state.getPendingItems()).toHaveLength(1);
    expect(state.getReadyItems()).toHaveLength(0);
  });

  it('marks an item as ready', () => {
    const item = state.enqueue({
      channel: 'nutrition',
      displayName: 'Nutrition',
      sessionKey: 'key',
      userMessage: 'test',
    });

    state.markReady(item.id, 'About 240 calories...', 'An avocado has about 240 calories.');

    expect(state.getPendingItems()).toHaveLength(0);
    expect(state.getReadyItems()).toHaveLength(1);

    const ready = state.getNextReady();
    expect(ready).not.toBeNull();
    expect(ready!.responseText).toBe('An avocado has about 240 calories.');
    expect(ready!.summary).toBe('About 240 calories...');
  });

  it('marks an item as heard', () => {
    const item = state.enqueue({
      channel: 'ch',
      displayName: 'Ch',
      sessionKey: 'key',
      userMessage: 'test',
    });

    state.markReady(item.id, 'summary', 'response');
    state.markHeard(item.id);

    expect(state.getReadyItems()).toHaveLength(0);
    expect(state.getPendingItems()).toHaveLength(0);
  });

  it('getNextReady returns oldest ready item', () => {
    const item1 = state.enqueue({ channel: 'a', displayName: 'A', sessionKey: 'k1', userMessage: 'first' });
    const item2 = state.enqueue({ channel: 'b', displayName: 'B', sessionKey: 'k2', userMessage: 'second' });

    state.markReady(item2.id, 'two', 'response two');
    state.markReady(item1.id, 'one', 'response one');

    // item1 was enqueued first, so it should come first
    const next = state.getNextReady();
    expect(next!.id).toBe(item1.id);
  });

  it('getReadyByChannel returns item for specific channel', () => {
    const item1 = state.enqueue({ channel: 'nutrition', displayName: 'Nutrition', sessionKey: 'k1', userMessage: 'q1' });
    const item2 = state.enqueue({ channel: 'budget', displayName: 'Budget', sessionKey: 'k2', userMessage: 'q2' });

    state.markReady(item1.id, 's1', 'r1');
    state.markReady(item2.id, 's2', 'r2');

    const budgetItem = state.getReadyByChannel('budget');
    expect(budgetItem).not.toBeNull();
    expect(budgetItem!.channel).toBe('budget');

    expect(state.getReadyByChannel('nonexistent')).toBeNull();
  });

  it('persists items across reloads', () => {
    const item = state.enqueue({ channel: 'ch', displayName: 'Ch', sessionKey: 'k', userMessage: 'msg' });
    state.markReady(item.id, 'sum', 'resp');

    const state2 = new QueueState();
    expect(state2.getReadyItems()).toHaveLength(1);
    expect(state2.getNextReady()!.responseText).toBe('resp');
  });
});
