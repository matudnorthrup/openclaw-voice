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
});

