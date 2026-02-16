/**
 * Layer 2: Open Mode Variant Tests
 *
 * Same single-channel setup but with gated-mode off.
 * Simpler path (no gate logic).
 *   2.1  Prompt without wake word → processed normally
 *   2.2  Command without wake word → recognized and dispatched
 *   2.3  Toggle gated mode on → confirms, subsequent no-wake utterance gated
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Service mocks ──────────────────────────────────────────────────────────

let transcribeImpl: (buf: Buffer) => Promise<string>;

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async (buf: Buffer) => transcribeImpl(buf)),
}));

let getResponseImpl: (user: string, msg: string, opts?: any) => Promise<{ response: string; history: any[] }>;

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async (user: string, msg: string, opts?: any) => getResponseImpl(user, msg, opts)),
  quickCompletion: vi.fn(async () => ''),
}));

vi.mock('../src/services/tts.js', () => ({
  textToSpeechStream: vi.fn(async () => Buffer.from('tts-audio')),
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

const earconHistory: string[] = [];
const playerCalls: string[] = [];

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
    }
    startWaitingLoop() { playerCalls.push('startWaitingLoop'); }
    stopWaitingLoop() { playerCalls.push('stopWaitingLoop'); }
    stopPlayback(_reason?: string) { playerCalls.push('stopPlayback'); }
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

let voiceSettings = { gated: false, silenceThreshold: 0.01, silenceDuration: 1500 };

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => voiceSettings),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn((enabled: boolean) => { voiceSettings.gated = enabled; }),
  resolveNoiseLevel: vi.fn(() => 0.01),
  getNoisePresetNames: vi.fn(() => ['low', 'medium', 'high']),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';

// ── Mock helpers ───────────────────────────────────────────────────────────

function makeRouter() {
  return {
    getActiveChannel: vi.fn(() => ({ name: 'walmart', displayName: 'Walmart' })),
    getActiveSessionKey: vi.fn(() => 'agent:main:discord:channel:walmart'),
    getSystemPrompt: vi.fn(() => 'system prompt'),
    refreshHistory: vi.fn(async () => {}),
    getHistory: vi.fn(() => []),
    setHistory: vi.fn(),
    listChannels: vi.fn(() => [{ name: 'walmart', displayName: 'Walmart' }]),
    getLogChannel: vi.fn(async () => null),
    getLogChannelFor: vi.fn(async () => null),
    getLastMessage: vi.fn(() => null),
    getLastMessageFresh: vi.fn(async () => null),
    getAllChannelSessionKeys: vi.fn(() => []),
    findForumChannel: vi.fn(() => null),
    listForumChannels: vi.fn(() => []),
    getForumThreads: vi.fn(async () => []),
    switchTo: vi.fn(async () => ({ success: true, displayName: 'Walmart' })),
    switchToDefault: vi.fn(async () => ({ success: true, displayName: 'Walmart' })),
    createForumPost: vi.fn(async () => ({ success: false, error: 'not implemented' })),
  };
}

function makeQueueState() {
  return {
    getMode: vi.fn(() => 'wait' as const),
    setMode: vi.fn(),
    enqueue: vi.fn(() => ({ id: 'q-1' })),
    markReady: vi.fn(),
    markHeard: vi.fn(),
    getReadyItems: vi.fn(() => []),
    getPendingItems: vi.fn(() => []),
    getNextReady: vi.fn(() => null),
    getReadyByChannel: vi.fn(() => null),
    getSnapshots: vi.fn(() => ({})),
    setSnapshots: vi.fn(),
    clearSnapshots: vi.fn(),
  };
}

function makePipeline() {
  const pipeline = new VoicePipeline({} as any);
  const router = makeRouter();
  const qs = makeQueueState();

  pipeline.setRouter(router as any);
  pipeline.setQueueState(qs as any);
  pipeline.setResponsePoller({ check: vi.fn() } as any);

  return { pipeline, router, qs };
}

async function simulateUtterance(pipeline: VoicePipeline, transcript: string) {
  transcribeImpl = async () => transcript;
  const receiver = (pipeline as any).receiver;
  await receiver.simulateUtterance('user1', Buffer.from('fake-audio'), 500);
  await new Promise((r) => setTimeout(r, 10));
}

function getState(pipeline: VoicePipeline): string {
  return (pipeline as any).stateMachine.getStateType();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Layer 2: Open Mode Variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerCalls.length = 0;
    voiceSettings = { gated: false, silenceThreshold: 0.01, silenceDuration: 1500 };
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'LLM says hello.', history: [] });
  });

  // ── 2.1: Prompt without wake word ─────────────────────────────────────

  it('2.1 — prompt without wake word is processed normally in open mode', async () => {
    const { pipeline } = makePipeline();

    await simulateUtterance(pipeline, 'add milk to my list');

    // In open mode without wake word, utterance goes through to LLM
    expect(playerCalls).toContain('playStream'); // TTS response spoken
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 2.2: Command without wake word ────────────────────────────────────

  it('2.2 — command without wake word is recognized in open mode', async () => {
    const { pipeline } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, voice status');

    expect(playerCalls).toContain('playStream');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 2.3: Toggle gated mode on ─────────────────────────────────────────

  it('2.3 — toggle gated mode on, then utterance without wake word is gated', async () => {
    const { pipeline } = makePipeline();

    // First: toggle gated mode on
    await simulateUtterance(pipeline, 'Watson, gated mode');

    expect(voiceSettings.gated).toBe(true);
    expect(playerCalls).toContain('playStream'); // confirmation spoken
    expect(getState(pipeline)).toBe('IDLE');

    // Wait for grace period to pass (ready cue opens grace)
    await new Promise((r) => setTimeout(r, 400));
    earconHistory.length = 0;
    playerCalls.length = 0;

    // Now: gated mode is on. Speak without wake word after grace expires.
    // Force gateGraceUntil to be in the past so we're definitely outside grace.
    (pipeline as any).ctx.gateGraceUntil = 0;
    (pipeline as any).ctx.promptGraceUntil = 0;

    await simulateUtterance(pipeline, 'add milk to my list');

    // Should be gated — no LLM call, no playStream for TTS response
    expect(playerCalls.filter((c) => c === 'playStream').length).toBe(0);
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });
});
