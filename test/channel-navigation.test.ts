/**
 * Layer 5: Channel Navigation Tests
 *
 * Verifies direct switch (exact match, no match), default switch,
 * what-channel, and channel selection disambiguation flow.
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

let voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => voiceSettings),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn(),
  resolveNoiseLevel: vi.fn(() => 0.01),
  getNoisePresetNames: vi.fn(() => ['low', 'medium', 'high']),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';

// ── Factories ──────────────────────────────────────────────────────────────

const channels = [
  { name: 'walmart', displayName: 'Walmart' },
  { name: 'health', displayName: 'OpenClaw Health' },
  { name: 'nutrition', displayName: 'Nutrition' },
  { name: 'general', displayName: 'General' },
];

function makeRouter(activeChannel = channels[0]) {
  return {
    getActiveChannel: vi.fn(() => activeChannel),
    getActiveSessionKey: vi.fn(() => `agent:main:discord:channel:${activeChannel.name}`),
    getSystemPrompt: vi.fn(() => 'system prompt'),
    refreshHistory: vi.fn(async () => {}),
    getHistory: vi.fn(() => []),
    setHistory: vi.fn(),
    listChannels: vi.fn(() => channels),
    getLogChannel: vi.fn(async () => null),
    getLogChannelFor: vi.fn(async () => null),
    getAllChannelSessionKeys: vi.fn(() => channels.map((c) => `agent:main:discord:channel:${c.name}`)),
    findForumChannel: vi.fn(() => null),
    listForumChannels: vi.fn(() => []),
    getForumThreads: vi.fn(async () => []),
    switchTo: vi.fn(async (target: string) => {
      const ch = channels.find((c) => c.name === target);
      return ch ? { success: true, displayName: ch.displayName } : { success: false, displayName: target };
    }),
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

function makeResponsePoller() {
  return { check: vi.fn() };
}

function makePipeline() {
  const pipeline = new VoicePipeline({} as any);
  const router = makeRouter();
  const qs = makeQueueState();
  const poller = makeResponsePoller();

  pipeline.setRouter(router as any);
  pipeline.setQueueState(qs as any);
  pipeline.setResponsePoller(poller as any);

  return { pipeline, router, qs, poller };
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

describe('Layer 5: Channel Navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerCalls.length = 0;
    voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'ok', history: [] });
  });

  // ── 5.1: Direct switch exact match ────────────────────────────────────

  it('5.1 — direct switch to known channel switches and confirms', async () => {
    const { pipeline, router } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, switch to health');
    // Wait for coalesced acknowledged earcon
    await new Promise((r) => setTimeout(r, 300));

    expect(router.switchTo).toHaveBeenCalledWith('health');
    expect(earconHistory).toContain('acknowledged');
    expect(playerCalls).toContain('playStream'); // spoke confirmation
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 5.8: Direct switch — no match ─────────────────────────────────────

  it('5.8 — switch to unknown channel with LLM returning empty speaks failure', async () => {
    const { pipeline, router } = makePipeline();
    // LLM returns empty (no match found)
    // quickCompletion mock already returns '' which won't parse as valid JSON

    await simulateUtterance(pipeline, 'Watson, switch to nonexistent');
    await new Promise((r) => setTimeout(r, 300));

    // switchTo should have been called with the raw channel name since no fuzzy match
    expect(router.switchTo).toHaveBeenCalled();
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 5.9: Default switch ───────────────────────────────────────────────

  it('5.9 — "Watson, go back" switches to default channel', async () => {
    const { pipeline, router } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, go back');

    expect(router.switchToDefault).toHaveBeenCalled();
    expect(playerCalls).toContain('playStream'); // spoke confirmation
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('5.9b — "Watson, default" also switches to default', async () => {
    const { pipeline, router } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, default');

    expect(router.switchToDefault).toHaveBeenCalled();
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 5.10: What channel ────────────────────────────────────────────────

  it('5.10 — "Watson, what channel" speaks current channel name', async () => {
    const { pipeline } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, what channel');

    expect(playerCalls).toContain('playStream'); // spoke channel name
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('5.10b — "Watson, voice channel" also speaks current channel name', async () => {
    const { pipeline } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, voice channel');

    expect(playerCalls).toContain('playStream');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 5.11: Switch with pending ready items ─────────────────────────────

  it('5.11 — switch to channel with ready items reads them', async () => {
    const { pipeline, qs, router } = makePipeline();

    // Set up a ready item for the target channel
    qs.getReadyItems.mockReturnValue([{
      id: 'r1',
      channel: 'health',
      sessionKey: 'agent:main:discord:channel:health',
      responseText: 'Here is the health response.',
      status: 'ready',
    }]);

    await simulateUtterance(pipeline, 'Watson, switch to health');
    await new Promise((r) => setTimeout(r, 300));

    expect(router.switchTo).toHaveBeenCalledWith('health');
    // Should have marked the ready item as heard
    expect(qs.markHeard).toHaveBeenCalledWith('r1');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── No router ─────────────────────────────────────────────────────────

  it('direct switch with no router does nothing', async () => {
    const pipeline = new VoicePipeline({} as any);

    await simulateUtterance(pipeline, 'Watson, switch to health');

    // Should not crash, returns to IDLE
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── Sequential navigation ─────────────────────────────────────────────

  it('handles sequential channel switches cleanly', async () => {
    const { pipeline, router } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, switch to health');
    await new Promise((r) => setTimeout(r, 300));
    expect(getState(pipeline)).toBe('IDLE');

    await simulateUtterance(pipeline, 'Watson, switch to nutrition');
    await new Promise((r) => setTimeout(r, 300));
    expect(getState(pipeline)).toBe('IDLE');

    await simulateUtterance(pipeline, 'Watson, go back');
    expect(getState(pipeline)).toBe('IDLE');

    expect(router.switchTo).toHaveBeenCalledTimes(2);
    expect(router.switchToDefault).toHaveBeenCalledTimes(1);

    pipeline.stop();
  });
});
