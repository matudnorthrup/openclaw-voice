/**
 * Layer 3: Queue Mode Tests
 *
 * Verifies the async queue mode flow: enqueue → notify → read.
 * Tests mode switching, queue prompt dispatch, idle notifications,
 * and queue prompt suppression.
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
  setGatedMode: vi.fn((enabled: boolean) => { voiceSettings.gated = enabled; }),
  resolveNoiseLevel: vi.fn(() => 0.01),
  getNoisePresetNames: vi.fn(() => ['low', 'medium', 'high']),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';

// ── Mock helpers ───────────────────────────────────────────────────────────

function makeQueueState(mode: 'wait' | 'queue' | 'ask' = 'queue') {
  const items: any[] = [];
  return {
    getMode: vi.fn(() => mode),
    setMode: vi.fn((m: string) => { mode = m as any; }),
    enqueue: vi.fn((params: any) => {
      const item = { id: `q-${items.length}`, ...params, status: 'pending', summary: '', responseText: '', timestamp: Date.now() };
      items.push(item);
      return item;
    }),
    markReady: vi.fn((id: string, summary: string, text: string) => {
      const item = items.find((i: any) => i.id === id);
      if (item) { item.status = 'ready'; item.summary = summary; item.responseText = text; }
    }),
    markHeard: vi.fn((id: string) => {
      const item = items.find((i: any) => i.id === id);
      if (item) item.status = 'heard';
    }),
    getReadyItems: vi.fn(() => items.filter((i: any) => i.status === 'ready')),
    getPendingItems: vi.fn(() => items.filter((i: any) => i.status === 'pending')),
    getNextReady: vi.fn(() => items.find((i: any) => i.status === 'ready') ?? null),
    getReadyByChannel: vi.fn((ch: string) => items.find((i: any) => i.status === 'ready' && i.channel === ch) ?? null),
    getSnapshots: vi.fn(() => ({})),
    setSnapshots: vi.fn(),
    clearSnapshots: vi.fn(),
    _items: items,
  };
}

function makeRouter(channelName = 'walmart', displayName = 'Walmart') {
  return {
    getActiveChannel: vi.fn(() => ({ name: channelName, displayName })),
    getActiveSessionKey: vi.fn(() => `agent:main:discord:channel:${channelName}`),
    getSystemPrompt: vi.fn(() => 'system prompt'),
    refreshHistory: vi.fn(async () => {}),
    getHistory: vi.fn(() => []),
    setHistory: vi.fn(),
    listChannels: vi.fn(() => [{ name: channelName, displayName }]),
    getLogChannel: vi.fn(async () => null),
    getLogChannelFor: vi.fn(async () => null),
    getAllChannelSessionKeys: vi.fn(() => []),
    findForumChannel: vi.fn(() => null),
    listForumChannels: vi.fn(() => []),
    getForumThreads: vi.fn(async () => []),
    switchTo: vi.fn(async () => ({ success: true, displayName })),
    switchToDefault: vi.fn(async () => ({ success: true, displayName: 'Default' })),
    createForumPost: vi.fn(async () => ({ success: false, error: 'not implemented' })),
  };
}

function makeResponsePoller() {
  return { check: vi.fn() };
}

function makePipeline(mode: 'wait' | 'queue' | 'ask' = 'queue') {
  const pipeline = new VoicePipeline({} as any);
  const qs = makeQueueState(mode);
  const router = makeRouter();
  const poller = makeResponsePoller();

  pipeline.setQueueState(qs as any);
  pipeline.setRouter(router as any);
  pipeline.setResponsePoller(poller as any);

  return { pipeline, qs, router, poller };
}

async function simulateUtterance(pipeline: VoicePipeline, userId: string, transcript: string) {
  transcribeImpl = async () => transcript;
  const receiver = (pipeline as any).receiver;
  await receiver.simulateUtterance(userId, Buffer.from('fake-audio'), 500);
  await new Promise((r) => setTimeout(r, 10));
}

function getState(pipeline: VoicePipeline): string {
  return (pipeline as any).stateMachine.getStateType();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Layer 3: Queue Mode Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerCalls.length = 0;
    voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'LLM response.', history: [] });
    ttsStreamImpl = async () => Buffer.from('tts-audio');
  });

  // ── 3.1: Mode switch ─────────────────────────────────────────────────

  it('3.1 — mode switch to queue mode sets mode and speaks confirmation', async () => {
    const { pipeline, qs } = makePipeline('wait');

    await simulateUtterance(pipeline, 'user1', 'Watson, inbox mode');

    expect(qs.setMode).toHaveBeenCalledWith('queue');
    expect(playerCalls).toContain('playStream'); // spoke "Inbox mode..."
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.1b — mode switch to wait mode from queue mode', async () => {
    const { pipeline, qs } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Watson, wait mode');

    expect(qs.setMode).toHaveBeenCalledWith('wait');
    expect(playerCalls).toContain('playStream');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 3.2: Queue prompt happy path ──────────────────────────────────────

  it('3.2 — queue mode prompt enqueues, acknowledges, speaks status, plays ready', async () => {
    const { pipeline, qs, router } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Watson, add milk to my list');

    // Should have enqueued (transcript includes wake word prefix)
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'Watson, add milk to my list',
      }),
    );
    // Should have played acknowledged earcon
    expect(earconHistory).toContain('acknowledged');
    // Should have spoken "Queued to Walmart." and inbox status via TTS
    expect(playerCalls.filter((c) => c === 'playStream').length).toBeGreaterThanOrEqual(2);
    // Should have played ready earcon
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 3.3: Background completion → idle notification ────────────────────

  it('3.3 — notifyIfIdle is called when LLM dispatch completes', async () => {
    const { pipeline, qs } = makePipeline('queue');
    const notifySpy = vi.spyOn(pipeline, 'notifyIfIdle');

    // Fast LLM
    getResponseImpl = async () => ({ response: 'Done.', history: [] });

    await simulateUtterance(pipeline, 'user1', 'Watson, add milk to my list');

    // Allow the fire-and-forget dispatch to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(notifySpy).toHaveBeenCalled();

    pipeline.stop();
  });

  // ── 3.6: Queue prompt suppression ─────────────────────────────────────

  it('3.6 — utterance in queue mode during grace without wake word is suppressed', async () => {
    const { pipeline, qs } = makePipeline('queue');

    // First: wake check to open grace window
    await simulateUtterance(pipeline, 'user1', 'Watson');
    const enqueueBefore = qs.enqueue.mock.calls.length;
    earconHistory.length = 0;
    playerCalls.length = 0;

    // Now speak without wake word during grace in queue mode — should be suppressed
    await simulateUtterance(pipeline, 'user1', 'add milk to my list');

    // Should NOT have enqueued (prompt suppressed)
    expect(qs.enqueue.mock.calls.length).toBe(enqueueBefore);
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── Queue mode with commands ──────────────────────────────────────────

  it('commands still work in queue mode with wake word', async () => {
    const { pipeline } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');

    expect(playerCalls).toContain('playStream');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── Counter tracking ──────────────────────────────────────────────────

  it('increments llmDispatches counter on queue mode dispatch', async () => {
    const { pipeline } = makePipeline('queue');
    getResponseImpl = async () => ({ response: 'Done.', history: [] });

    await simulateUtterance(pipeline, 'user1', 'Watson, add milk to my list');
    await new Promise((r) => setTimeout(r, 20));

    expect(pipeline.getCounters().llmDispatches).toBeGreaterThanOrEqual(1);

    pipeline.stop();
  });
});
