import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineStateMachine, type TransitionEffect, type PipelineEvent } from '../src/pipeline/pipeline-state.js';

describe('PipelineStateMachine', () => {
  let sm: PipelineStateMachine;

  beforeEach(() => {
    vi.useFakeTimers();
    sm = new PipelineStateMachine();
  });

  afterEach(() => {
    sm.destroy();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('starts in IDLE', () => {
      expect(sm.getStateType()).toBe('IDLE');
    });

    it('has no buffered utterance', () => {
      expect(sm.hasBufferedUtterance()).toBe(false);
      expect(sm.getBufferedUtterance()).toBeNull();
    });
  });

  describe('IDLE → TRANSCRIBING', () => {
    it('transitions to TRANSCRIBING on utterance received', () => {
      const effects = sm.transition({ type: 'UTTERANCE_RECEIVED' });
      expect(sm.getStateType()).toBe('TRANSCRIBING');
      expect(effects).toEqual([]);
    });
  });

  describe('TRANSCRIBING → PROCESSING', () => {
    it('transitions to PROCESSING on transcript ready', () => {
      sm.transition({ type: 'UTTERANCE_RECEIVED' });
      const effects = sm.transition({ type: 'TRANSCRIPT_READY', transcript: 'hello' });
      expect(sm.getStateType()).toBe('PROCESSING');
      expect(effects).toEqual([]);
    });
  });

  describe('PROCESSING → IDLE', () => {
    it('transitions to IDLE on processing complete', () => {
      sm.transition({ type: 'UTTERANCE_RECEIVED' });
      sm.transition({ type: 'PROCESSING_STARTED' });
      const effects = sm.transition({ type: 'PROCESSING_COMPLETE' });
      expect(sm.getStateType()).toBe('IDLE');
      expect(effects).toEqual([]);
    });
  });

  describe('SPEAKING → IDLE', () => {
    it('transitions to IDLE on speaking complete', () => {
      sm.transition({ type: 'SPEAKING_STARTED' });
      expect(sm.getStateType()).toBe('SPEAKING');
      const effects = sm.transition({ type: 'SPEAKING_COMPLETE' });
      expect(sm.getStateType()).toBe('IDLE');
      expect(effects).toEqual([]);
    });
  });

  describe('utterance during PROCESSING — buffer + busy earcon', () => {
    it('produces busy earcon when utterance arrives during PROCESSING', () => {
      sm.transition({ type: 'PROCESSING_STARTED' });
      const effects = sm.transition({ type: 'UTTERANCE_RECEIVED' });
      expect(effects).toEqual([{ type: 'earcon', name: 'busy' }]);
      // State should NOT change — still PROCESSING
      expect(sm.getStateType()).toBe('PROCESSING');
    });

    it('allows buffering an utterance during PROCESSING', () => {
      sm.transition({ type: 'PROCESSING_STARTED' });
      sm.transition({ type: 'UTTERANCE_RECEIVED' });

      const wavBuffer = Buffer.from('test-audio');
      sm.bufferUtterance('user1', wavBuffer, 1000);
      expect(sm.hasBufferedUtterance()).toBe(true);

      const buffered = sm.getBufferedUtterance();
      expect(buffered).toEqual({ userId: 'user1', wavBuffer, durationMs: 1000 });
      // Consumed after retrieval
      expect(sm.hasBufferedUtterance()).toBe(false);
    });

    it('buffers up to 3 utterances and drops the oldest when full', () => {
      sm.bufferUtterance('u1', Buffer.from('a'), 100);
      sm.bufferUtterance('u2', Buffer.from('b'), 200);
      sm.bufferUtterance('u3', Buffer.from('c'), 300);
      sm.bufferUtterance('u4', Buffer.from('d'), 400);

      const first = sm.getBufferedUtterance();
      const second = sm.getBufferedUtterance();
      const third = sm.getBufferedUtterance();
      const none = sm.getBufferedUtterance();

      expect(first?.userId).toBe('u2');
      expect(second?.userId).toBe('u3');
      expect(third?.userId).toBe('u4');
      expect(none).toBeNull();
    });
  });

  describe('utterance during SPEAKING — stop playback + busy earcon', () => {
    it('produces stop-playback and busy earcon', () => {
      sm.transition({ type: 'SPEAKING_STARTED' });
      const effects = sm.transition({ type: 'UTTERANCE_RECEIVED' });
      expect(effects).toEqual([
        { type: 'stop-playback' },
        { type: 'earcon', name: 'busy' },
      ]);
      // Stays SPEAKING — pipeline decides when to actually transition
      expect(sm.getStateType()).toBe('SPEAKING');
    });
  });

  describe('AWAITING_CHANNEL_SELECTION', () => {
    const options = [
      { index: 1, name: 'general', displayName: 'General' },
      { index: 2, name: 'random', displayName: 'Random' },
    ];

    it('enters channel selection state', () => {
      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options, timeoutMs: 15000 });
      expect(sm.getStateType()).toBe('AWAITING_CHANNEL_SELECTION');
      const state = sm.getChannelSelectionState();
      expect(state?.options).toEqual(options);
    });

    it('produces error earcon + reprompt on unrecognized input', () => {
      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options, timeoutMs: 15000 });
      const effects = sm.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      expect(effects).toContainEqual({ type: 'earcon', name: 'error' });
      expect(effects).toContainEqual({
        type: 'speak',
        text: 'Say a number or channel name, or cancel.',
      });
    });

    it('uses contract default timeout when timeout is omitted', () => {
      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options });
      expect(sm.getChannelSelectionState()?.timeoutMs).toBe(15000);
    });

    it('no effects on recognized input', () => {
      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options, timeoutMs: 15000 });
      const effects = sm.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: true });
      expect(effects).toEqual([]);
    });

    it('fires timeout warning 5s before expiry', () => {
      const timeoutEffects: TransitionEffect[][] = [];
      sm.setTimeoutHandler((e) => timeoutEffects.push(e));

      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options, timeoutMs: 15000 });

      // Advance to 10s (warning point)
      vi.advanceTimersByTime(10000);
      expect(timeoutEffects.length).toBe(1);
      expect(timeoutEffects[0]).toContainEqual({ type: 'earcon', name: 'timeout-warning' });
    });

    it('fires cancelled earcon + spoken message on full timeout', () => {
      const timeoutEffects: TransitionEffect[][] = [];
      sm.setTimeoutHandler((e) => timeoutEffects.push(e));

      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options, timeoutMs: 15000 });

      vi.advanceTimersByTime(15000);
      // Should have warning at 10s and timeout at 15s
      expect(timeoutEffects.length).toBe(2);
      const lastEffects = timeoutEffects[1];
      expect(lastEffects).toContainEqual({ type: 'earcon', name: 'cancelled' });
      expect(lastEffects).toContainEqual(expect.objectContaining({ type: 'speak' }));
      expect(sm.getStateType()).toBe('IDLE');
    });
  });

  describe('AWAITING_QUEUE_CHOICE', () => {
    it('enters queue choice state with userId and transcript', () => {
      sm.transition({
        type: 'ENTER_QUEUE_CHOICE',
        userId: 'user1',
        transcript: 'hello world',
        timeoutMs: 20000,
      });
      expect(sm.getStateType()).toBe('AWAITING_QUEUE_CHOICE');
      const state = sm.getQueueChoiceState();
      expect(state?.userId).toBe('user1');
      expect(state?.transcript).toBe('hello world');
    });

    it('reprompts with correct text on unrecognized input', () => {
      sm.transition({
        type: 'ENTER_QUEUE_CHOICE',
        userId: 'user1',
        transcript: 'hello',
        timeoutMs: 20000,
      });
      const effects = sm.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      expect(effects).toContainEqual({ type: 'earcon', name: 'error' });
      expect(effects).toContainEqual({
        type: 'speak',
        text: 'Say send to inbox, wait here, or cancel.',
      });
    });

    it('uses contract default timeout when timeout is omitted', () => {
      sm.transition({
        type: 'ENTER_QUEUE_CHOICE',
        userId: 'user1',
        transcript: 'hello',
      });
      expect(sm.getQueueChoiceState()?.timeoutMs).toBe(20000);
    });
  });

  describe('AWAITING_SWITCH_CHOICE', () => {
    it('enters switch choice state with lastMessage', () => {
      sm.transition({
        type: 'ENTER_SWITCH_CHOICE',
        lastMessage: 'Last message content',
        timeoutMs: 30000,
      });
      expect(sm.getStateType()).toBe('AWAITING_SWITCH_CHOICE');
      const state = sm.getSwitchChoiceState();
      expect(state?.lastMessage).toBe('Last message content');
    });

    it('reprompts with correct text on unrecognized input', () => {
      sm.transition({
        type: 'ENTER_SWITCH_CHOICE',
        lastMessage: 'msg',
        timeoutMs: 30000,
      });
      const effects = sm.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      expect(effects).toContainEqual({ type: 'earcon', name: 'error' });
      expect(effects).toContainEqual({
        type: 'speak',
        text: 'Say last message, new prompt, or cancel.',
      });
    });

    it('uses contract default timeout when timeout is omitted', () => {
      sm.transition({
        type: 'ENTER_SWITCH_CHOICE',
        lastMessage: 'msg',
      });
      expect(sm.getSwitchChoiceState()?.timeoutMs).toBe(30000);
    });

    it('pauses timeout timers when utterance is received during awaiting', () => {
      const timeoutEffects: TransitionEffect[][] = [];
      sm.setTimeoutHandler((e) => timeoutEffects.push(e));

      sm.transition({
        type: 'ENTER_SWITCH_CHOICE',
        lastMessage: 'msg',
        timeoutMs: 7000,
      });
      vi.advanceTimersByTime(1200);
      sm.transition({ type: 'UTTERANCE_RECEIVED' });
      vi.advanceTimersByTime(7000);

      expect(timeoutEffects.length).toBe(0);
      expect(sm.getStateType()).toBe('AWAITING_SWITCH_CHOICE');
    });

    it('resets timeout window after unrecognized input reprompt', () => {
      const timeoutEffects: TransitionEffect[][] = [];
      sm.setTimeoutHandler((e) => timeoutEffects.push(e));

      sm.transition({
        type: 'ENTER_SWITCH_CHOICE',
        lastMessage: 'msg',
        timeoutMs: 7000,
      });
      vi.advanceTimersByTime(1200);

      const effects = sm.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      expect(effects).toContainEqual({ type: 'earcon', name: 'error' });

      vi.advanceTimersByTime(6900);
      expect(timeoutEffects.length).toBe(1);
      expect(timeoutEffects[0]).toContainEqual({ type: 'earcon', name: 'timeout-warning' });

      vi.advanceTimersByTime(100);
      expect(timeoutEffects.length).toBe(2);
      expect(timeoutEffects[1]).toContainEqual({ type: 'earcon', name: 'cancelled' });
      expect(timeoutEffects[1]).toContainEqual({ type: 'speak', text: 'Switch choice timed out.' });
    });
  });

  describe('NEW_POST_FLOW', () => {
    it('enters new-post flow at forum step', () => {
      sm.transition({
        type: 'ENTER_NEW_POST_FLOW',
        step: 'forum',
        timeoutMs: 30000,
      });
      expect(sm.getStateType()).toBe('NEW_POST_FLOW');
      const state = sm.getNewPostFlowState();
      expect(state?.step).toBe('forum');
    });

    it('advances through steps', () => {
      sm.transition({
        type: 'ENTER_NEW_POST_FLOW',
        step: 'forum',
        timeoutMs: 30000,
      });

      sm.transition({
        type: 'NEW_POST_ADVANCE',
        step: 'title',
        forumId: 'forum1',
        forumName: 'General',
        timeoutMs: 30000,
      });
      expect(sm.getNewPostFlowState()?.step).toBe('title');
      expect(sm.getNewPostFlowState()?.forumId).toBe('forum1');
    });

    it('reprompts correctly per step', () => {
      sm.transition({ type: 'ENTER_NEW_POST_FLOW', step: 'forum', timeoutMs: 30000 });
      let effects = sm.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      expect(effects).toContainEqual({ type: 'speak', text: 'Say a forum name, or cancel.' });

      sm.transition({ type: 'NEW_POST_ADVANCE', step: 'title', forumId: 'f1', timeoutMs: 30000 });
      effects = sm.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      expect(effects).toContainEqual({ type: 'speak', text: 'Say the title, or cancel.' });
    });

    it('fires timeout warning before expiry', () => {
      const timeoutEffects: TransitionEffect[][] = [];
      sm.setTimeoutHandler((e) => timeoutEffects.push(e));

      sm.transition({ type: 'ENTER_NEW_POST_FLOW', step: 'forum', timeoutMs: 30000 });

      // Warning at 25s
      vi.advanceTimersByTime(25000);
      expect(timeoutEffects.length).toBe(1);
      expect(timeoutEffects[0]).toContainEqual({ type: 'earcon', name: 'timeout-warning' });
    });

  });

  describe('INBOX_FLOW', () => {
    const items = [
      { channelName: 'ch1', displayName: 'Channel 1' },
      { channelName: 'ch2', displayName: 'Channel 2' },
    ];

    it('enters inbox flow', () => {
      sm.transition({ type: 'ENTER_INBOX_FLOW', items });
      expect(sm.getStateType()).toBe('INBOX_FLOW');
      const state = sm.getInboxFlowState();
      expect(state?.items).toEqual(items);
      expect(state?.index).toBe(0);
    });

    it('advances index', () => {
      sm.transition({ type: 'ENTER_INBOX_FLOW', items });
      sm.transition({ type: 'INBOX_ADVANCE' });
      const state = sm.getInboxFlowState();
      expect(state?.index).toBe(1);
    });
  });

  describe('CANCEL_FLOW', () => {
    it('returns to IDLE with cancelled earcon', () => {
      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options: [], timeoutMs: 15000 });
      const effects = sm.transition({ type: 'CANCEL_FLOW' });
      expect(sm.getStateType()).toBe('IDLE');
      expect(effects).toContainEqual({ type: 'earcon', name: 'cancelled' });
    });

    it('clears timers on cancel', () => {
      const timeoutEffects: TransitionEffect[][] = [];
      sm.setTimeoutHandler((e) => timeoutEffects.push(e));

      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options: [], timeoutMs: 15000 });
      sm.transition({ type: 'CANCEL_FLOW' });

      // Advance past timeout — no effects should fire
      vi.advanceTimersByTime(20000);
      expect(timeoutEffects.length).toBe(0);
    });
  });

  describe('RETURN_TO_IDLE', () => {
    it('returns to IDLE without earcon', () => {
      sm.transition({ type: 'PROCESSING_STARTED' });
      const effects = sm.transition({ type: 'RETURN_TO_IDLE' });
      expect(sm.getStateType()).toBe('IDLE');
      expect(effects).toEqual([]);
    });
  });

  describe('isAwaitingState', () => {
    it('returns true for AWAITING states', () => {
      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options: [], timeoutMs: 15000 });
      expect(sm.isAwaitingState()).toBe(true);
    });

    it('returns true for NEW_POST_FLOW', () => {
      sm.transition({ type: 'ENTER_NEW_POST_FLOW', step: 'forum', timeoutMs: 30000 });
      expect(sm.isAwaitingState()).toBe(true);
    });

    it('returns false for IDLE', () => {
      expect(sm.isAwaitingState()).toBe(false);
    });

    it('returns false for PROCESSING', () => {
      sm.transition({ type: 'PROCESSING_STARTED' });
      expect(sm.isAwaitingState()).toBe(false);
    });

    it('returns false for INBOX_FLOW', () => {
      sm.transition({ type: 'ENTER_INBOX_FLOW', items: [] });
      expect(sm.isAwaitingState()).toBe(false);
    });
  });

  describe('no effects on unrecognized input outside AWAITING states', () => {
    it('IDLE: no reprompt', () => {
      const effects = sm.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      expect(effects).toEqual([]);
    });

    it('PROCESSING: no reprompt', () => {
      sm.transition({ type: 'PROCESSING_STARTED' });
      const effects = sm.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      expect(effects).toEqual([]);
    });
  });

  describe('hasActiveTimers', () => {
    it('returns false in IDLE', () => {
      expect(sm.hasActiveTimers()).toBe(false);
    });

    it('returns true after entering an AWAITING state', () => {
      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options: [], timeoutMs: 15000 });
      expect(sm.hasActiveTimers()).toBe(true);
    });

    it('returns true after entering queue choice', () => {
      sm.transition({ type: 'ENTER_QUEUE_CHOICE', userId: 'u1', transcript: 'hi', timeoutMs: 20000 });
      expect(sm.hasActiveTimers()).toBe(true);
    });

    it('returns true after entering new-post flow', () => {
      sm.transition({ type: 'ENTER_NEW_POST_FLOW', step: 'forum', timeoutMs: 30000 });
      expect(sm.hasActiveTimers()).toBe(true);
    });

    it('returns false after CANCEL_FLOW clears timers', () => {
      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options: [], timeoutMs: 15000 });
      sm.transition({ type: 'CANCEL_FLOW' });
      expect(sm.hasActiveTimers()).toBe(false);
    });

    it('returns false after destroy', () => {
      sm.transition({ type: 'ENTER_SWITCH_CHOICE', lastMessage: 'msg', timeoutMs: 30000 });
      expect(sm.hasActiveTimers()).toBe(true);
      sm.destroy();
      expect(sm.hasActiveTimers()).toBe(false);
    });

    it('returns false in PROCESSING (no timeout timers)', () => {
      sm.transition({ type: 'PROCESSING_STARTED' });
      expect(sm.hasActiveTimers()).toBe(false);
    });

    it('clears timers when UTTERANCE_RECEIVED pauses an awaiting state', () => {
      sm.transition({ type: 'ENTER_SWITCH_CHOICE', lastMessage: 'msg', timeoutMs: 30000 });
      expect(sm.hasActiveTimers()).toBe(true);
      sm.transition({ type: 'UTTERANCE_RECEIVED' });
      expect(sm.hasActiveTimers()).toBe(false);
    });
  });

  describe('invalid transition warnings', () => {
    it('warns when TRANSCRIPT_READY arrives in non-TRANSCRIBING state', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sm.transition({ type: 'TRANSCRIPT_READY', transcript: 'hello' });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('TRANSCRIPT_READY arrived in non-TRANSCRIBING state'),
      );
      warnSpy.mockRestore();
    });

    it('does not warn when TRANSCRIPT_READY arrives in TRANSCRIBING state', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sm.transition({ type: 'UTTERANCE_RECEIVED' });
      expect(sm.getStateType()).toBe('TRANSCRIBING');
      sm.transition({ type: 'TRANSCRIPT_READY', transcript: 'hello' });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('warns when INBOX_ADVANCE arrives in non-INBOX_FLOW state', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sm.transition({ type: 'INBOX_ADVANCE' });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('INBOX_ADVANCE arrived in non-INBOX_FLOW state'),
      );
      warnSpy.mockRestore();
    });

    it('does not warn when INBOX_ADVANCE arrives in INBOX_FLOW state', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sm.transition({ type: 'ENTER_INBOX_FLOW', items: [{ channelName: 'ch1' }] });
      sm.transition({ type: 'INBOX_ADVANCE' });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('destroy cleans up', () => {
    it('resets to IDLE and clears buffered utterance', () => {
      sm.transition({ type: 'PROCESSING_STARTED' });
      sm.bufferUtterance('user1', Buffer.from('test'), 500);
      sm.destroy();
      expect(sm.getStateType()).toBe('IDLE');
      expect(sm.hasBufferedUtterance()).toBe(false);
    });

    it('clears timers', () => {
      const timeoutEffects: TransitionEffect[][] = [];
      sm.setTimeoutHandler((e) => timeoutEffects.push(e));

      sm.transition({ type: 'ENTER_CHANNEL_SELECTION', options: [], timeoutMs: 15000 });
      sm.destroy();

      vi.advanceTimersByTime(20000);
      expect(timeoutEffects.length).toBe(0);
    });
  });
});
