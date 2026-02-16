/**
 * Layer 1 Foundation Tests
 *
 * Single channel, wait mode, gated mode — the most common usage pattern.
 * Tests the core pipeline lifecycle: wake → command/prompt → response → IDLE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Service mocks ──────────────────────────────────────────────────────────

let transcribeImpl: (buf: Buffer) => Promise<string>;

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async (buf: Buffer) => transcribeImpl(buf)),
}));

let getResponseImpl: (user: string, msg: string) => Promise<{ response: string }>;

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async (user: string, msg: string) => getResponseImpl(user, msg)),
  quickCompletion: vi.fn(async () => ''),
}));

let ttsStreamImpl: (text: string) => Promise<Buffer>;

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
    hasActiveSpeech() { return false; }
    simulateUtterance(userId: string, wav: Buffer, durationMs: number) {
      return this.onUtterance(userId, wav, durationMs);
    }
  },
}));

const playerCalls: string[] = [];
const earconHistory: string[] = [];
let playStreamCb: ((text: string) => void) | null = null;

vi.mock('../src/discord/audio-player.js', () => ({
  DiscordAudioPlayer: class {
    attach() {}
    isPlaying() { return false; }
    isWaiting() { return false; }
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
      playStreamCb?.(_stream?.toString?.() ?? '');
    }
    startWaitingLoop() { playerCalls.push('startWaitingLoop'); }
    stopWaitingLoop() { playerCalls.push('stopWaitingLoop'); }
    stopPlayback(_reason?: string) { playerCalls.push('stopPlayback'); }
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

// Mock voice settings — start in gated mode
let voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => voiceSettings),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn((enabled: boolean) => { voiceSettings.gated = enabled; }),
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
    voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };

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
