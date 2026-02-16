import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async () => ({ response: 'ok', history: [] })),
  quickCompletion: vi.fn(async () => ''),
}));

vi.mock('../src/discord/audio-player.js', () => ({
  DiscordAudioPlayer: class {
    attach() {}
    isPlaying() { return false; }
    isWaiting() { return false; }
    isPlayingEarcon() { return false; }
    async playEarcon() {}
    playEarconSync() {}
    async playStream() {}
    playSingleTone() {}
    startWaitingLoop() {}
    stopWaitingLoop() {}
    stopPlayback() {}
  },
}));

vi.mock('../src/discord/audio-receiver.js', () => ({
  AudioReceiver: class {
    constructor() {}
    start() {}
    stop() {}
    hasActiveSpeech() { return false; }
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

vi.mock('../src/services/tts.js', () => ({
  textToSpeechStream: vi.fn(async () => Buffer.from('')),
}));

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async () => ''),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';
import { checkPipelineInvariants } from '../src/pipeline/pipeline-invariants.js';
import { transcribe } from '../src/services/whisper.js';
import { textToSpeechStream } from '../src/services/tts.js';

const transcribeMock = vi.mocked(transcribe);
const ttsMock = vi.mocked(textToSpeechStream);

describe('Pipeline fault injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recovers to IDLE after STT (transcribe) failure', async () => {
    transcribeMock.mockRejectedValueOnce(new Error('Whisper local error'));

    const pipeline = new VoicePipeline({} as any);
    const playEarconSpy = vi.spyOn((pipeline as any).player, 'playEarcon');

    await (pipeline as any).handleUtterance('user1', Buffer.alloc(100), 500);

    const stateType = (pipeline as any).stateMachine.getStateType();
    expect(stateType).toBe('IDLE');
    expect(playEarconSpy).toHaveBeenCalled();

    pipeline.stop();
  });

  it('recovers to IDLE after TTS failure during speak', async () => {
    transcribeMock.mockResolvedValueOnce('Hello Watson test');
    ttsMock.mockRejectedValueOnce(new Error('Kokoro TTS connection refused'));

    const pipeline = new VoicePipeline({} as any);

    await (pipeline as any).handleUtterance('user1', Buffer.alloc(100), 500);

    const stateType = (pipeline as any).stateMachine.getStateType();
    expect(stateType).toBe('IDLE');

    const counters = pipeline.getCounters();
    expect(counters.errors).toBeGreaterThanOrEqual(1);

    pipeline.stop();
  });

  it('stall watchdog fires and resets to IDLE', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const pipeline = new VoicePipeline({} as any);
      const playEarconSpy = vi.spyOn((pipeline as any).player, 'playEarcon');

      // Force into PROCESSING state
      (pipeline as any).stateMachine.transition({ type: 'UTTERANCE_RECEIVED' });
      (pipeline as any).stateMachine.transition({ type: 'TRANSCRIPT_READY', transcript: 'test' });
      expect((pipeline as any).stateMachine.getStateType()).toBe('PROCESSING');

      // Reset watchdog to start the 60s timer
      (pipeline as any).resetStallWatchdog();

      // Advance time past the stall watchdog threshold (60s)
      vi.advanceTimersByTime(61_000);

      // Should have reset to IDLE
      expect((pipeline as any).stateMachine.getStateType()).toBe('IDLE');
      expect(playEarconSpy).toHaveBeenCalledWith('error');

      const counters = pipeline.getCounters();
      expect(counters.stallWatchdogFires).toBeGreaterThanOrEqual(1);

      pipeline.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects invariant violation: AWAITING state with no timers', () => {
    const pipeline = new VoicePipeline({} as any);

    // Force AWAITING_CHANNEL_SELECTION state
    (pipeline as any).stateMachine.transition({
      type: 'ENTER_CHANNEL_SELECTION',
      options: [{ index: 1, name: 'test', displayName: 'Test' }],
    });
    expect((pipeline as any).stateMachine.getStateType()).toBe('AWAITING_CHANNEL_SELECTION');

    // Manually clear the state machine timers to simulate a bug
    (pipeline as any).stateMachine.clearTimers();

    const ctx = (pipeline as any).getInvariantContext();
    const violations = checkPipelineInvariants(ctx);

    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0].label).toBe('awaiting-no-timers');

    pipeline.stop();
  });

  it('resets transient context fully on stop()', async () => {
    transcribeMock.mockRejectedValueOnce(new Error('Whisper local error'));

    const pipeline = new VoicePipeline({} as any);

    // Set some transient state
    (pipeline as any).ctx.silentWait = true;
    (pipeline as any).ctx.missedWakeAnalysisInFlight = true;
    (pipeline as any).ctx.failedWakeCueCooldownUntil = Date.now() + 99999;

    await (pipeline as any).handleUtterance('user1', Buffer.alloc(100), 500);

    // Pipeline should be in IDLE after error recovery
    expect((pipeline as any).stateMachine.getStateType()).toBe('IDLE');

    pipeline.stop();

    // After stop(), transient context should be fully clean
    const ctx = (pipeline as any).ctx;
    expect(ctx.silentWait).toBe(false);
    expect(ctx.missedWakeAnalysisInFlight).toBe(false);
    expect(ctx.failedWakeCueCooldownUntil).toBe(0);
    expect(ctx.pendingWaitCallback).toBeNull();
    expect(ctx.activeWaitQueueItemId).toBeNull();
    expect(ctx.speculativeQueueItemId).toBeNull();
    expect(ctx.quietPendingWait).toBe(false);
    expect(ctx.deferredWaitResponseText).toBeNull();
    expect(ctx.rejectRepromptInFlight).toBe(false);
    expect(ctx.idleNotifyInFlight).toBe(false);
    expect(ctx.newPostTimeoutPromptGuardUntil).toBe(0);
  });
});
