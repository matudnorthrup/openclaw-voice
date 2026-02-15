import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractionFlowHarness } from '../src/testing/interaction-flow-harness.js';

describe('InteractionFlowHarness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reprompts and then accepts queue choice intent', () => {
    const h = new InteractionFlowHarness();
    h.enterQueueChoice('u1', 'test prompt');
    h.clearEvents();

    h.sendTranscript('maybe');
    h.sendTranscript('wait here');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'unrecognized', transcript: 'maybe' },
        { type: 'earcon', name: 'error' },
        { type: 'speak', text: 'Say send to inbox, wait here, or cancel.' },
        { type: 'ready' },
        { type: 'recognized', intent: 'wait' },
        { type: 'earcon', name: 'acknowledged' },
      ]),
    );

    h.destroy();
  });

  it('reads last message on switch-choice read and returns ready', () => {
    const h = new InteractionFlowHarness();
    h.enterSwitchChoice('Watson: Here is your last message.');
    h.clearEvents();

    h.sendTranscript('last message');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'read' },
        { type: 'earcon', name: 'acknowledged' },
        { type: 'speak', text: 'Watson: Here is your last message.' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });

  it('accepts channel-selection by number', () => {
    const h = new InteractionFlowHarness();
    h.enterChannelSelection([
      { index: 1, name: 'general', displayName: 'General' },
      { index: 2, name: 'nutrition', displayName: 'Nutrition' },
    ]);
    h.clearEvents();

    h.sendTranscript('2');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'channel:nutrition' },
        { type: 'earcon', name: 'acknowledged' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });

  it('handles timeout warning and cancellation deterministically', () => {
    vi.useFakeTimers();
    const h = new InteractionFlowHarness();
    h.enterSwitchChoice('last');
    h.clearEvents();

    vi.advanceTimersByTime(25_000);
    vi.advanceTimersByTime(5_000);

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'earcon', name: 'timeout-warning' },
        { type: 'earcon', name: 'cancelled' },
        { type: 'speak', text: 'Switch choice timed out.' },
      ]),
    );

    h.destroy();
  });

  it('treats ambiguous queue choice as unrecognized and reprompts', () => {
    const h = new InteractionFlowHarness();
    h.enterQueueChoice('u1', 'test prompt');
    h.clearEvents();

    h.sendTranscript('inbox wait');

    expect(h.getState()).toBe('AWAITING_QUEUE_CHOICE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'unrecognized', transcript: 'inbox wait' },
        { type: 'earcon', name: 'error' },
        { type: 'speak', text: 'Say send to inbox, wait here, or cancel.' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });

  it('accepts wake-word navigation intent inside queue-choice', () => {
    const h = new InteractionFlowHarness();
    h.enterQueueChoice('u1', 'test prompt');
    h.clearEvents();

    h.sendTranscript('Hey Watson, switch to nutrition');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'switch' },
        { type: 'earcon', name: 'acknowledged' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });

  it('resets timeout window after unrecognized input', () => {
    vi.useFakeTimers();
    const h = new InteractionFlowHarness();
    h.enterQueueChoice('u1', 'test prompt');
    h.clearEvents();

    vi.advanceTimersByTime(10_000);
    h.sendTranscript('unknown');
    h.clearEvents();

    vi.advanceTimersByTime(15_000);
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([{ type: 'earcon', name: 'timeout-warning' }]),
    );

    vi.advanceTimersByTime(5_000);
    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'earcon', name: 'cancelled' },
        { type: 'speak', text: 'Choice timed out.' },
      ]),
    );

    h.destroy();
  });

  it('rejects non-wake transcript in gated mode outside ready grace', () => {
    const h = new InteractionFlowHarness();
    h.setGatedMode(true);
    h.clearEvents();

    h.sendTranscript('what is in my inbox');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'rejected', transcript: 'what is in my inbox', reason: 'gated-no-wake' },
      ]),
    );

    h.destroy();
  });

  it('accepts non-wake transcript in gated mode during ready grace', () => {
    vi.useFakeTimers();
    const h = new InteractionFlowHarness();
    h.setGatedMode(true);
    h.playReadyCue(5_000);
    h.clearEvents();

    h.sendTranscript('what is in my inbox');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'prompt' },
        { type: 'speak', text: 'Simulated assistant response.' },
      ]),
    );

    h.destroy();
  });

  it('requires wake word again after ready grace expires in gated mode', () => {
    vi.useFakeTimers();
    const h = new InteractionFlowHarness();
    h.setGatedMode(true);
    h.playReadyCue(5_000);
    vi.advanceTimersByTime(5_001);
    h.clearEvents();

    h.sendTranscript('what is in my inbox');

    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'rejected', transcript: 'what is in my inbox', reason: 'gated-no-wake' },
      ]),
    );

    h.destroy();
  });

  it('accepts wake-word command in gated mode outside grace', () => {
    const h = new InteractionFlowHarness();
    h.setGatedMode(true);
    h.clearEvents();

    h.sendTranscript('Hey Watson, inbox');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'inbox-check' },
        { type: 'earcon', name: 'acknowledged' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });

  it('treats repeated wake-only utterance as wake-check, not prompt', () => {
    const h = new InteractionFlowHarness();
    h.setGatedMode(true);
    h.clearEvents();

    h.sendTranscript('Hello Watson. Hello Watson.');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'wake-check' },
        { type: 'earcon', name: 'acknowledged' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });

  it('maps "I\'m done" to default outside inbox flow', () => {
    const h = new InteractionFlowHarness();
    h.clearEvents();

    h.sendTranscript("Hey Watson, I'm done");

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'default' },
        { type: 'earcon', name: 'acknowledged' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });

  it('recognizes dispatch command as command intent', () => {
    const h = new InteractionFlowHarness();
    h.clearEvents();

    h.sendTranscript('Hey Watson, dispatch to planning channel start the nightly plan');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'dispatch' },
        { type: 'earcon', name: 'acknowledged' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });

  it('keeps awaiting menus wake-word free even in gated mode', () => {
    const h = new InteractionFlowHarness();
    h.setGatedMode(true);
    h.enterQueueChoice('u1', 'message');
    h.clearEvents();

    h.sendTranscript('wait here');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'wait' },
        { type: 'earcon', name: 'acknowledged' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });

  it('opens ready grace after switch-choice read, enabling immediate no-wake follow-up', () => {
    vi.useFakeTimers();
    const h = new InteractionFlowHarness();
    h.setGatedMode(true);
    h.enterSwitchChoice('Watson: Last message body.');
    h.clearEvents();

    h.sendTranscript('last message');
    expect(h.isInReadyGraceWindow()).toBe(true);
    h.clearEvents();

    h.sendTranscript('summarize that');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'prompt' },
        { type: 'speak', text: 'Simulated assistant response.' },
      ]),
    );

    h.destroy();
  });

  it('accepts navigation command from switch-choice menu', () => {
    const h = new InteractionFlowHarness();
    h.enterSwitchChoice('Watson: Last message body.');
    h.clearEvents();

    h.sendTranscript('Hey Watson, switch to nutrition');

    expect(h.getState()).toBe('IDLE');
    expect(h.getEvents()).toEqual(
      expect.arrayContaining([
        { type: 'recognized', intent: 'switch' },
        { type: 'earcon', name: 'acknowledged' },
        { type: 'ready' },
      ]),
    );

    h.destroy();
  });
});
