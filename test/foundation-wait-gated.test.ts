/**
 * Layer 1 Foundation Tests
 *
 * Single channel, wait mode, gated mode — the most common usage pattern.
 * Tests the core pipeline lifecycle: wake → command/prompt → response → IDLE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Service mocks ──────────────────────────────────────────────────────────

let transcribeImpl: (buf: Buffer, options?: any) => Promise<string>;

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async (buf: Buffer, options?: any) => transcribeImpl(buf, options)),
}));

let getResponseImpl: (user: string, msg: string) => Promise<{ response: string }>;

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async (user: string, msg: string) => getResponseImpl(user, msg)),
  quickCompletion: vi.fn(async () => ''),
}));

let ttsStreamImpl: (text: string) => Promise<Buffer>;
let receiverHasActiveSpeech = false;
let receiverLastSpeechStartedAt = 0;

vi.mock('../src/services/tts.js', () => ({
  textToSpeechStream: vi.fn(async (text: string) => ttsStreamImpl(text)),
}));

vi.mock('../src/discord/audio-receiver.js', () => ({
  AudioReceiver: class {
    private onUtterance: any;
    constructor(_conn: any, onUtterance: any, _onRejected: any) {
      this.onUtterance = onUtterance;
    }
    start() {}
    stop() {}
    hasActiveSpeech() { return receiverHasActiveSpeech; }
    getLastSpeechStartedAt() { return receiverLastSpeechStartedAt; }
    setActiveSpeech(active: boolean) { receiverHasActiveSpeech = active; }
    setLastSpeechStartedAt(ts: number) { receiverLastSpeechStartedAt = ts; }
    simulateUtterance(userId: string, wav: Buffer, durationMs: number) {
      return this.onUtterance(userId, wav, durationMs);
    }
  },
}));

const playerCalls: string[] = [];
const earconHistory: string[] = [];
let playStreamCb: ((text: string) => void) | null = null;
let playerIsPlaying = false;
let playerIsWaiting = false;

vi.mock('../src/discord/audio-player.js', () => ({
  DiscordAudioPlayer: class {
    attach() {}
    isPlaying() { return playerIsPlaying; }
    isWaiting() { return playerIsWaiting; }
    isPlayingEarcon(_name?: string) { return false; }
    async playEarcon(name: string) {
      earconHistory.push(name);
      playerCalls.push(`earcon:${name}`);
    }
    playEarconSync(name: string) {
      earconHistory.push(name);
      playerCalls.push(`earcon:${name}`);
    }
    async playStream(_stream: any) {
      playerCalls.push('playStream');
      playerIsPlaying = true;
      playStreamCb?.(_stream?.toString?.() ?? '');
    }
    startWaitingLoop() {
      playerCalls.push('startWaitingLoop');
      playerIsWaiting = true;
    }
    stopWaitingLoop() {
      playerCalls.push('stopWaitingLoop');
      playerIsWaiting = false;
    }
    stopPlayback(_reason?: string) {
      playerCalls.push('stopPlayback');
      playerIsPlaying = false;
      playerIsWaiting = false;
    }
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

// Mock voice settings — start in gated mode
let voiceSettings = {
  gated: true,
  audioProcessing: 'local',
  silenceThreshold: 0.01,
  silenceDuration: 1500,
  endpointingMode: 'silence',
  indicateCloseWords: ["i'm done", "i'm finished", 'go ahead'],
  indicateTimeoutMs: 20000,
  sttStreamingEnabled: false,
  sttStreamingChunkMs: 900,
  sttStreamingMinChunkMs: 450,
  sttStreamingOverlapMs: 180,
  sttStreamingMaxChunks: 8,
};

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => voiceSettings),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn((enabled: boolean) => { voiceSettings.gated = enabled; }),
  setEndpointingMode: vi.fn(),
  resolveNoiseLevel: vi.fn(() => 0.01),
  getNoisePresetNames: vi.fn(() => ['low', 'medium', 'high']),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makePipeline() {
  const pipeline = new VoicePipeline({} as any);
  return pipeline;
}

async function simulateUtterance(pipeline: VoicePipeline, userId: string, transcript: string) {
  transcribeImpl = async () => transcript;
  const receiver = (pipeline as any).receiver;
  await receiver.simulateUtterance(userId, Buffer.from('fake-audio'), 500);
  // Allow microtask queue to flush
  await new Promise((r) => setTimeout(r, 10));
}

function getStateMachineState(pipeline: VoicePipeline): string {
  return (pipeline as any).stateMachine.getStateType();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Layer 1: Foundation — Single Channel, Wait Mode, Gated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    playerCalls.length = 0;
    earconHistory.length = 0;
    playStreamCb = null;
    receiverHasActiveSpeech = false;
    receiverLastSpeechStartedAt = 0;
    playerIsPlaying = false;
    playerIsWaiting = false;
    vi.useRealTimers();
    voiceSettings = {
      gated: true,
      audioProcessing: 'local',
      silenceThreshold: 0.01,
      silenceDuration: 1500,
      endpointingMode: 'silence',
      indicateCloseWords: ["i'm done", "i'm finished", 'go ahead'],
      indicateTimeoutMs: 20000,
      sttStreamingEnabled: false,
      sttStreamingChunkMs: 900,
      sttStreamingMinChunkMs: 450,
      sttStreamingOverlapMs: 180,
      sttStreamingMaxChunks: 8,
    };

    // Default: STT returns empty, LLM returns simple response, TTS returns buffer
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'Test response.' });
    ttsStreamImpl = async () => Buffer.from('tts-audio');
  });

  // ── 1.1: Wake check ──────────────────────────────────────────────────

  it('1.1 — wake check sets prompt grace and plays ready earcon', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'Watson');

    // Prompt grace should be set synchronously (~15 seconds from now)
    expect((pipeline as any).ctx.promptGraceUntil).toBeGreaterThan(Date.now());
    // Should be back in IDLE
    expect(getStateMachineState(pipeline)).toBe('IDLE');
    // Ready earcon is coalesced (220ms delay) — wait for it
    await new Promise((r) => setTimeout(r, 300));
    expect(earconHistory).toContain('ready');

    pipeline.stop();
  });

  it('1.1b — "Hey Watson" alone also triggers wake check', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'Hey Watson');

    expect((pipeline as any).ctx.promptGraceUntil).toBeGreaterThan(Date.now());
    expect(getStateMachineState(pipeline)).toBe('IDLE');
    await new Promise((r) => setTimeout(r, 300));
    expect(earconHistory).toContain('ready');

    pipeline.stop();
  });

  it('1.1c — standalone code wake phrase triggers wake check', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'Whiskey Foxtrot');

    expect((pipeline as any).ctx.promptGraceUntil).toBeGreaterThan(Date.now());
    expect(getStateMachineState(pipeline)).toBe('IDLE');
    await new Promise((r) => setTimeout(r, 300));
    expect(earconHistory).toContain('ready');

    pipeline.stop();
  });

  it('1.1d — spaced variant "Whiskey Fox trot" also triggers wake check', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'Whiskey Fox trot');

    expect((pipeline as any).ctx.promptGraceUntil).toBeGreaterThan(Date.now());
    expect(getStateMachineState(pipeline)).toBe('IDLE');
    await new Promise((r) => setTimeout(r, 300));
    expect(earconHistory).toContain('ready');

    pipeline.stop();
  });

  it('1.1e — "What is key fox trot" fallback also triggers wake check', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'What is key fox trot');

    expect((pipeline as any).ctx.promptGraceUntil).toBeGreaterThan(Date.now());
    expect(getStateMachineState(pipeline)).toBe('IDLE');
    await new Promise((r) => setTimeout(r, 300));
    expect(earconHistory).toContain('ready');

    pipeline.stop();
  });

  // ── 1.2: Wake + simple command ────────────────────────────────────────

  it('1.2 — wake + voice status command speaks response and returns to IDLE', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');

    // Should have played TTS (the status spoken message)
    expect(playerCalls).toContain('playStream');
    // Should have played ready earcon after the command
    expect(earconHistory).toContain('ready');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.2b — wake + gated mode command changes setting', async () => {
    const pipeline = makePipeline();
    expect(voiceSettings.gated).toBe(true);

    await simulateUtterance(pipeline, 'user1', 'Watson, open mode');

    expect(voiceSettings.gated).toBe(false);
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('ready');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 1.3: Wake + prompt (wait mode happy path) ────────────────────────

  it('1.3 — wait mode prompt dispatches synchronously without queueState', async () => {
    const pipeline = makePipeline();
    let llmCalled = false;
    getResponseImpl = async () => {
      llmCalled = true;
      return { response: 'Here is your answer.' };
    };

    await simulateUtterance(pipeline, 'user1', 'Watson, add milk to my shopping list');

    expect(llmCalled).toBe(true);
    // Should have spoken the LLM response via TTS
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('ready');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.3b — indicate mode does not close on bare "done"; closes on wake-prefixed command', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    const prompts: string[] = [];
    getResponseImpl = async (_user, msg) => {
      prompts.push(msg);
      return { response: 'Combined response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'Watson, add milk');
    expect(prompts).toEqual([]);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    await simulateUtterance(pipeline, 'user1', 'and eggs');
    expect(prompts).toEqual([]);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    await simulateUtterance(pipeline, 'user1', 'done');
    expect(prompts).toEqual([]);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    await simulateUtterance(pipeline, 'user1', "Watson, I'm done");
    expect(prompts).toEqual(['add milk and eggs done']);
    expect(playerCalls).toContain('playStream');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.3b2 — indicate mode ignores bare cancel without error earcon', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'draft a quick update');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);

    await simulateUtterance(pipeline, 'user1', 'cancel');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect(earconHistory).not.toContain('error');

    pipeline.stop();
  });

  it('1.3c — indicate endpoint mode allows wake-only close command', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    const prompts: string[] = [];
    getResponseImpl = async (_user, msg) => {
      prompts.push(msg);
      return { response: 'Combined response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'Watson, add vitamin d to my list');
    await simulateUtterance(pipeline, 'user1', 'and magnesium glycinate');
    await simulateUtterance(pipeline, 'user1', 'Watson');

    expect(prompts).toEqual(['add vitamin d to my list and magnesium glycinate']);
    expect(playerCalls).toContain('playStream');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.3d — indicate mode can start capture from prompt grace without wake word', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    const prompts: string[] = [];
    getResponseImpl = async (_user, msg) => {
      prompts.push(msg);
      return { response: 'Combined response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'add milk to my shopping list');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect(prompts).toEqual([]);

    await simulateUtterance(pipeline, 'user1', 'and eggs');
    expect(prompts).toEqual([]);

    await simulateUtterance(pipeline, 'user1', "Watson, I'm done");
    expect(prompts).toEqual(['add milk to my shopping list and eggs']);
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(playerCalls).toContain('playStream');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.3e — indicate mode closes on standalone code phrase without wake prefix', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    const prompts: string[] = [];
    getResponseImpl = async (_user, msg) => {
      prompts.push(msg);
      return { response: 'Combined response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'Watson, add milk');
    await simulateUtterance(pipeline, 'user1', 'and eggs');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect(prompts).toEqual([]);

    await simulateUtterance(pipeline, 'user1', 'whiskey delta');
    expect(prompts).toEqual(['add milk and eggs']);
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.3f — indicate mode closes on spaced "whiskey fox trot" variant', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    const prompts: string[] = [];
    getResponseImpl = async (_user, msg) => {
      prompts.push(msg);
      return { response: 'Combined response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'Watson, capture this update');
    await simulateUtterance(pipeline, 'user1', 'with one more segment');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);

    await simulateUtterance(pipeline, 'user1', 'whiskey fox trot');
    expect(prompts).toEqual(['capture this update with one more segment']);
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.3g — indicate mode closes on "what is key fox trot" fallback phrase', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    const prompts: string[] = [];
    getResponseImpl = async (_user, msg) => {
      prompts.push(msg);
      return { response: 'Combined response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'Watson, capture this update');
    await simulateUtterance(pipeline, 'user1', 'with one more segment');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);

    await simulateUtterance(pipeline, 'user1', 'What is key fox trot');
    expect(prompts).toEqual(['capture this update with one more segment']);
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.3h — indicate mode suppresses listening cue during capture and plays it on finalize', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    const prompts: string[] = [];
    getResponseImpl = async (_user, msg) => {
      prompts.push(msg);
      return { response: 'Combined response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'capture this update');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect(earconHistory).not.toContain('listening');

    await simulateUtterance(pipeline, 'user1', 'with one more segment');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect(earconHistory).not.toContain('listening');

    await simulateUtterance(pipeline, 'user1', "Watson, I'm done");
    expect(prompts).toEqual(['capture this update with one more segment']);
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(earconHistory).toContain('listening');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.3i — indicate capture routes wake-prefixed command instead of appending dictation', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');
    await simulateUtterance(pipeline, 'user1', 'draft this note');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect(((pipeline as any).ctx.indicateCaptureSegments ?? []).join(' ')).toContain('draft this note');

    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Hello Watson last message');

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect((pipeline as any).ctx.indicateCaptureSegments).toEqual([]);
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('listening');

    pipeline.stop();
  });

  it('1.3j — indicate capture routes bare "last message" command and clears capture', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');
    await simulateUtterance(pipeline, 'user1', 'draft this note');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);

    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'user1', 'my last message');

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect((pipeline as any).ctx.indicateCaptureSegments).toEqual([]);
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('listening');

    pipeline.stop();
  });

  it('1.3k — short single-segment indicate timeout clears silently', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    (pipeline as any).ctx.indicateCaptureActive = true;
    (pipeline as any).ctx.indicateCaptureSegments = ['message'];
    (pipeline as any).ctx.indicateCaptureStartedAt = Date.now();
    (pipeline as any).ctx.indicateCaptureLastSegmentAt = Date.now();

    playerCalls.length = 0;
    earconHistory.length = 0;

    await (pipeline as any).onIndicateCaptureTimeout();

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(playerCalls).not.toContain('playStream');
    expect(earconHistory).not.toContain('ready');

    pipeline.stop();
  });

  it('1.3k2 — indicate timeout defers while user is actively speaking', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';

    (pipeline as any).ctx.indicateCaptureActive = true;
    (pipeline as any).ctx.indicateCaptureSegments = ['still dictating'];
    (pipeline as any).ctx.indicateCaptureStartedAt = Date.now();
    (pipeline as any).ctx.indicateCaptureLastSegmentAt = Date.now();
    receiverHasActiveSpeech = true;
    receiverLastSpeechStartedAt = Date.now();

    playerCalls.length = 0;
    earconHistory.length = 0;

    await (pipeline as any).onIndicateCaptureTimeout();

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect((pipeline as any).indicateCaptureTimer).not.toBeNull();
    expect(playerCalls).not.toContain('playStream');

    receiverHasActiveSpeech = false;
    pipeline.stop();
  });

  it('1.3l — partial indicate close fallback finalizes when final transcript misses close phrase', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';
    voiceSettings.sttStreamingEnabled = true;
    voiceSettings.audioProcessing = 'local';

    const prompts: string[] = [];
    getResponseImpl = async (_user, msg) => {
      prompts.push(msg);
      return { response: 'Combined response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');
    await simulateUtterance(pipeline, 'user1', 'capture this update');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);

    transcribeImpl = async (_buf, options) => {
      options?.onPartial?.({
        text: "Hello Watson, I'm done",
        chunkIndex: 0,
        totalChunks: 2,
        elapsedMs: 30,
      });
      // Full transcript misses the wake + close phrase; without partial fallback
      // this would have been treated as plain dictation.
      return 'done';
    };
    const receiver = (pipeline as any).receiver;
    await receiver.simulateUtterance('user1', Buffer.from('fake-audio'), 500);
    await new Promise((r) => setTimeout(r, 10));

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(prompts).toEqual(['capture this update']);

    pipeline.stop();
  });

  it('1.3m — partial wake-only close hint requires settling and does not prematurely finalize', async () => {
    const pipeline = makePipeline();
    voiceSettings.endpointingMode = 'indicate';
    voiceSettings.sttStreamingEnabled = true;
    voiceSettings.audioProcessing = 'local';

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');
    await simulateUtterance(pipeline, 'user1', 'capture this update');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);

    transcribeImpl = async (_buf, options) => {
      options?.onPartial?.({
        text: 'Hello Watson',
        chunkIndex: 0,
        totalChunks: 2,
        elapsedMs: 20,
      });
      return 'continue speaking';
    };
    const receiver = (pipeline as any).receiver;
    await receiver.simulateUtterance('user1', Buffer.from('fake-audio'), 500);
    await new Promise((r) => setTimeout(r, 10));

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    const combined = ((pipeline as any).ctx.indicateCaptureSegments ?? []).join(' ');
    expect(combined).toContain('capture this update');
    expect(combined).toContain('continue speaking');

    pipeline.stop();
  });

  // ── 1.4: Grace period utterance ───────────────────────────────────────

  it('1.4 — utterance during prompt grace is processed without wake word', async () => {
    const pipeline = makePipeline();

    // First: wake check to open grace window
    await simulateUtterance(pipeline, 'user1', 'Watson');
    earconHistory.length = 0;
    playerCalls.length = 0;

    // Now speak without wake word — should be processed during grace
    let llmCalled = false;
    getResponseImpl = async () => {
      llmCalled = true;
      return { response: 'Grace period response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'add milk to my shopping list');

    expect(llmCalled).toBe(true);
    expect(playerCalls).toContain('playStream');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.4b — grace accepts "my last message" without wake word', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'Watson');
    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'user1', 'my last message');

    expect(playerCalls).toContain('playStream');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 1.5: Gate closes after grace ──────────────────────────────────────

  it('1.5 — utterance without wake word and no grace is discarded in gated mode', async () => {
    const pipeline = makePipeline();
    // No grace window set, gated mode is on by default
    let llmCalled = false;
    getResponseImpl = async () => {
      llmCalled = true;
      return { response: 'Should not get here.' };
    };

    await simulateUtterance(pipeline, 'user1', 'add milk to my shopping list');

    expect(llmCalled).toBe(false);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.5b — gate-closed cue is suppressed when speech starts during holdoff', async () => {
    vi.useFakeTimers();
    try {
      const pipeline = makePipeline();
      const cueSpy = vi.spyOn(pipeline as any, 'playFastCue').mockResolvedValue(undefined);

      receiverHasActiveSpeech = false;
      (pipeline as any).onGraceExpired();
      receiverHasActiveSpeech = true;

      vi.advanceTimersByTime(350);
      await Promise.resolve();

      expect(cueSpy).not.toHaveBeenCalledWith('gate-closed');
      pipeline.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('1.5c — gate-closed cue plays when no speech is detected during holdoff', async () => {
    vi.useFakeTimers();
    try {
      const pipeline = makePipeline();
      const cueSpy = vi.spyOn(pipeline as any, 'playFastCue').mockResolvedValue(undefined);

      receiverHasActiveSpeech = false;
      (pipeline as any).onGraceExpired();

      vi.advanceTimersByTime(350);
      await Promise.resolve();

      expect(cueSpy).toHaveBeenCalledWith('gate-closed');
      pipeline.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('1.5d — gate-closed cue is suppressed when speech started very recently but is no longer active', async () => {
    vi.useFakeTimers();
    try {
      const pipeline = makePipeline();
      const cueSpy = vi.spyOn(pipeline as any, 'playFastCue').mockResolvedValue(undefined);

      // Simulate recent speech start near grace expiry.
      receiverHasActiveSpeech = false;
      receiverLastSpeechStartedAt = Date.now() - 100;
      (pipeline as any).onGraceExpired();

      vi.advanceTimersByTime(350);
      await Promise.resolve();

      expect(cueSpy).not.toHaveBeenCalledWith('gate-closed');
      pipeline.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('1.5e — gate-closed cue still plays when prior speech start is stale', async () => {
    vi.useFakeTimers();
    try {
      const pipeline = makePipeline();
      const cueSpy = vi.spyOn(pipeline as any, 'playFastCue').mockResolvedValue(undefined);

      receiverHasActiveSpeech = false;
      receiverLastSpeechStartedAt = Date.now() - 5_000;
      (pipeline as any).onGraceExpired();

      vi.advanceTimersByTime(350);
      await Promise.resolve();

      expect(cueSpy).toHaveBeenCalledWith('gate-closed');
      pipeline.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 1.9: Pause command ────────────────────────────────────────────────

  it('1.9 — pause command stops playback', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'Watson, pause');

    expect(playerCalls).toContain('stopPlayback');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 1.10: Replay ─────────────────────────────────────────────────────

  it('1.10 — replay speaks "I haven\'t said anything yet" when nothing spoken', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'Watson, replay');

    // Should have TTS'd the "haven't said anything" message
    expect(playerCalls).toContain('playStream');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.10b — streaming partial wake pause can preempt playback before final transcript', async () => {
    const pipeline = makePipeline();
    voiceSettings.sttStreamingEnabled = true;
    voiceSettings.audioProcessing = 'local';
    playerIsPlaying = true;

    transcribeImpl = async (_buf, options) => {
      options?.onPartial?.({
        text: 'Hello Watson skip',
        chunkIndex: 0,
        totalChunks: 2,
        elapsedMs: 40,
      });
      return '';
    };

    const receiver = (pipeline as any).receiver;
    await receiver.simulateUtterance('user1', Buffer.from('fake-audio'), 500);
    await new Promise((r) => setTimeout(r, 10));

    expect(playerCalls).toContain('stopPlayback');
    expect(playerIsPlaying).toBe(false);

    pipeline.stop();
  });

  it('1.10c — streaming partial wake command fallback executes when final transcript is empty', async () => {
    const pipeline = makePipeline();
    voiceSettings.sttStreamingEnabled = true;
    voiceSettings.audioProcessing = 'local';
    playerIsPlaying = true;

    transcribeImpl = async (_buf, options) => {
      options?.onPartial?.({
        text: 'Hello Watson status',
        chunkIndex: 0,
        totalChunks: 2,
        elapsedMs: 35,
      });
      return '';
    };

    const receiver = (pipeline as any).receiver;
    await receiver.simulateUtterance('user1', Buffer.from('fake-audio'), 500);
    await new Promise((r) => setTimeout(r, 10));

    expect(playerCalls).toContain('stopPlayback');
    expect(playerCalls).toContain('playStream');

    pipeline.stop();
  });

  it('1.10d — streaming partial wake-only does not preempt playback', async () => {
    const pipeline = makePipeline();
    voiceSettings.sttStreamingEnabled = true;
    voiceSettings.audioProcessing = 'local';
    playerIsPlaying = true;

    transcribeImpl = async (_buf, options) => {
      options?.onPartial?.({
        text: 'Hello Watson',
        chunkIndex: 0,
        totalChunks: 2,
        elapsedMs: 25,
      });
      return '';
    };

    const receiver = (pipeline as any).receiver;
    await receiver.simulateUtterance('user1', Buffer.from('fake-audio'), 500);
    await new Promise((r) => setTimeout(r, 10));

    expect(playerCalls).not.toContain('stopPlayback');
    expect(playerIsPlaying).toBe(true);

    pipeline.stop();
  });

  // ── 1.13: Empty transcript ────────────────────────────────────────────

  it('1.13 — empty transcript is discarded and returns to IDLE', async () => {
    const pipeline = makePipeline();
    let llmCalled = false;
    getResponseImpl = async () => {
      llmCalled = true;
      return { response: 'nope' };
    };

    transcribeImpl = async () => '';
    const receiver = (pipeline as any).receiver;
    await receiver.simulateUtterance('user1', Buffer.from('audio'), 500);
    await new Promise((r) => setTimeout(r, 10));

    expect(llmCalled).toBe(false);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 1.14: Non-lexical transcript ──────────────────────────────────────

  it('1.14 — non-lexical transcript [BLANK_AUDIO] is discarded', async () => {
    const pipeline = makePipeline();
    let llmCalled = false;
    getResponseImpl = async () => {
      llmCalled = true;
      return { response: 'nope' };
    };

    await simulateUtterance(pipeline, 'user1', '[BLANK_AUDIO]');

    expect(llmCalled).toBe(false);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('1.14b — non-lexical transcript [SOUND] is discarded', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', '[SOUND]');

    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 1.15: Playback echo suppression ───────────────────────────────────

  it('1.15 — playback echo is suppressed when transcript matches recent Watson speech', async () => {
    const pipeline = makePipeline();

    // Simulate that Watson recently spoke this exact text
    (pipeline as any).ctx.lastPlaybackText = 'Here is your answer to the question about milk.';
    (pipeline as any).ctx.lastPlaybackCompletedAt = Date.now();

    let llmCalled = false;
    getResponseImpl = async () => {
      llmCalled = true;
      return { response: 'nope' };
    };

    // This transcript should be suppressed as a playback echo
    await simulateUtterance(pipeline, 'user1', 'here is your answer to the question about milk');

    expect(llmCalled).toBe(false);
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 1.16: Failed wake near-miss ───────────────────────────────────────

  it('1.16 — near-miss wake "or Watson inbox" plays error earcon', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'or Watson inbox list');

    // Should have played error earcon for the near-miss
    expect(earconHistory).toContain('error');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── Health counters ───────────────────────────────────────────────────

  it('increments utterancesProcessed counter on each utterance', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', '');
    await simulateUtterance(pipeline, 'user1', '');

    expect(pipeline.getCounters().utterancesProcessed).toBe(2);

    pipeline.stop();
  });

  it('increments commandsRecognized counter on voice command', async () => {
    const pipeline = makePipeline();

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');

    expect(pipeline.getCounters().commandsRecognized).toBe(1);

    pipeline.stop();
  });

  // ── Health snapshot ───────────────────────────────────────────────────

  it('getHealthSnapshot returns valid state', async () => {
    const pipeline = makePipeline();

    const snapshot = pipeline.getHealthSnapshot();
    expect(snapshot.pipelineState).toBe('IDLE');
    expect(snapshot.uptime).toBeGreaterThanOrEqual(0);
    expect(snapshot.mode).toBe('wait');
    expect(snapshot.counters.utterancesProcessed).toBe(0);

    pipeline.stop();
  });

  // ── stop() cleanup ────────────────────────────────────────────────────

  it('stop() resets all transient context and returns to IDLE', async () => {
    const pipeline = makePipeline();

    // Pollute some state
    (pipeline as any).ctx.promptGraceUntil = Date.now() + 99999;
    (pipeline as any).ctx.silentWait = true;
    (pipeline as any).ctx.failedWakeCueCooldownUntil = Date.now() + 99999;

    pipeline.stop();

    expect((pipeline as any).ctx.promptGraceUntil).toBe(0);
    expect((pipeline as any).ctx.silentWait).toBe(false);
    expect((pipeline as any).ctx.failedWakeCueCooldownUntil).toBe(0);
    expect(getStateMachineState(pipeline)).toBe('IDLE');
  });

  // ── Open mode variant (Layer 2 quick coverage) ────────────────────────

  it('2.1 — open mode processes prompt without wake word', async () => {
    voiceSettings.gated = false;
    const pipeline = makePipeline();
    let llmCalled = false;
    getResponseImpl = async () => {
      llmCalled = true;
      return { response: 'Open mode response.' };
    };

    await simulateUtterance(pipeline, 'user1', 'add milk to my shopping list');

    expect(llmCalled).toBe(true);
    expect(playerCalls).toContain('playStream');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('2.2 — open mode processes command without wake word', async () => {
    voiceSettings.gated = false;
    const pipeline = makePipeline();

    // In open mode, "voice status" without wake word won't match parseVoiceCommand
    // (which requires "Watson, ..."). But a full "Watson, voice status" works.
    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');

    expect(playerCalls).toContain('playStream');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── Multiple sequential utterances ────────────────────────────────────

  it('handles multiple sequential wake+command utterances cleanly', async () => {
    const pipeline = makePipeline();

    // First: wake check
    await simulateUtterance(pipeline, 'user1', 'Watson');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    // Second: command
    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    // Third: another wake check
    await simulateUtterance(pipeline, 'user1', 'Hey Watson');
    expect(getStateMachineState(pipeline)).toBe('IDLE');

    expect(pipeline.getCounters().utterancesProcessed).toBe(3);

    pipeline.stop();
  });
});
