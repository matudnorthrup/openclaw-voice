import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async () => {
    throw new Error('fetch failed');
  }),
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
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

vi.mock('../src/services/tts.js', () => ({
  textToSpeechStream: vi.fn(async () => {
    throw new Error('tts not expected in this test');
  }),
}));

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async () => ''),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';

describe('VoicePipeline dispatch failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks queued item ready with explicit failure message when fire-and-forget dispatch fails', async () => {
    const pipeline = new VoicePipeline({} as any);

    const queueState = {
      markReady: vi.fn(),
      markHeard: vi.fn(),
      getReadyItems: vi.fn(() => []),
      getPendingItems: vi.fn(() => []),
    };
    const responsePoller = { check: vi.fn() };
    const router = {
      refreshHistory: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      setHistory: vi.fn(() => {}),
    };

    pipeline.setQueueState(queueState as any);
    pipeline.setResponsePoller(responsePoller as any);
    pipeline.setRouter(router as any);

    (pipeline as any).dispatchToLLMFireAndForget(
      'voice-user',
      'add milk',
      'qid-1',
      {
        channelName: 'walmart',
        displayName: 'Walmart',
        sessionKey: 'agent:main:discord:channel:1',
        systemPrompt: 'system',
      },
    );

    await new Promise((r) => setTimeout(r, 20));

    expect(queueState.markReady).toHaveBeenCalledWith(
      'qid-1',
      'Dispatch failed: gateway connection error.',
      'I could not complete that request because the gateway connection failed. Please try again.',
    );
    expect(responsePoller.check).toHaveBeenCalled();

    pipeline.stop();
  });

  it('detects near-miss wake phrasing without loosening strict wake matching', () => {
    const pipeline = new VoicePipeline({} as any);

    expect((pipeline as any).shouldCueFailedWake('or Watson inbox list')).toBe(true);
    expect((pipeline as any).shouldCueFailedWake('or Watson')).toBe(true);
    expect((pipeline as any).shouldCueFailedWake('weak test')).toBe(true);
    expect((pipeline as any).shouldCueFailedWake('wake check')).toBe(true);
    expect((pipeline as any).shouldCueFailedWake('Hello Watson inbox list')).toBe(false);
    expect((pipeline as any).shouldCueFailedWake('I talked to Watson yesterday')).toBe(false);

    pipeline.stop();
  });

  it('rate-limits failed-wake earcon cue', async () => {
    const pipeline = new VoicePipeline({} as any);
    const cueSpy = vi.spyOn(pipeline as any, 'playFastCue').mockResolvedValue(undefined);

    (pipeline as any).cueFailedWakeIfNeeded('or Watson inbox list');
    (pipeline as any).cueFailedWakeIfNeeded('or Watson inbox list');
    await new Promise((r) => setTimeout(r, 0));

    expect(cueSpy).toHaveBeenCalledTimes(1);
    expect(cueSpy).toHaveBeenCalledWith('error');

    pipeline.stop();
  });

  it('detects cancel intent with repeated/newline variants', () => {
    const pipeline = new VoicePipeline({} as any);
    expect((pipeline as any).isCancelIntent('cancel')).toBe(true);
    expect((pipeline as any).isCancelIntent('Cancel.\nCancel.')).toBe(true);
    expect((pipeline as any).isCancelIntent('please stop this')).toBe(true);
    expect((pipeline as any).isCancelIntent('carry on')).toBe(false);
    pipeline.stop();
  });

  it('enables post-timeout prompt guard and clears it on explicit command', async () => {
    const pipeline = new VoicePipeline({} as any);
    vi.spyOn(pipeline as any, 'speakResponse').mockResolvedValue(undefined);
    vi.spyOn(pipeline as any, 'playReadyEarcon').mockResolvedValue(undefined);

    expect((pipeline as any).ctx.newPostTimeoutPromptGuardUntil).toBe(0);

    await (pipeline as any).applyEffects([
      { type: 'earcon', name: 'cancelled' },
      { type: 'speak', text: 'New post flow timed out.' },
    ]);

    expect((pipeline as any).ctx.newPostTimeoutPromptGuardUntil).toBeGreaterThan(Date.now());

    await (pipeline as any).handleVoiceCommand({ type: 'voice-status' }, 'voice-user');
    expect((pipeline as any).ctx.newPostTimeoutPromptGuardUntil).toBe(0);

    pipeline.stop();
  });

  it('ignores non-lexical bracketed transcripts', () => {
    const pipeline = new VoicePipeline({} as any);
    expect((pipeline as any).isNonLexicalTranscript('[SOUND]')).toBe(true);
    expect((pipeline as any).isNonLexicalTranscript('[BLANK_AUDIO]')).toBe(true);
    expect((pipeline as any).isNonLexicalTranscript('[MUSIC] [NOISE]')).toBe(true);
    expect((pipeline as any).isNonLexicalTranscript('go to health')).toBe(false);
    pipeline.stop();
  });

  it('matches ready items by session key for direct switch clearing', () => {
    const pipeline = new VoicePipeline({} as any);
    const queueState = {
      getReadyItems: vi.fn(() => [
        { id: 'r1', sessionKey: 'session:health', channel: 'openclaw-health' },
      ]),
    };
    pipeline.setQueueState(queueState as any);

    const items = (pipeline as any).getReadyItemsForSession('session:health', 'health');
    expect(items).toHaveLength(1);
    pipeline.stop();
  });
});
