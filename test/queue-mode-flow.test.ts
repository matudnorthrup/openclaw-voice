/**
 * Layer 3: Queue Mode Tests
 *
 * Verifies the async queue mode flow: enqueue → notify → read.
 * Tests mode switching, queue prompt dispatch, idle notifications,
 * and queue prompt handling during grace windows.
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
    getLastSpeechStartedAt() { return 0; }
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

let voiceSettings = {
  gated: true,
  silenceThreshold: 0.01,
  silenceDuration: 1500,
  silenceDurationMs: 1500,
  speechThreshold: 500,
  minSpeechDurationMs: 300,
  endpointingMode: 'silence',
  indicateCloseWords: ["i'm done", "i'm finished", 'go ahead'],
  indicateTimeoutMs: 20000,
};

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => voiceSettings),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn((enabled: boolean) => { voiceSettings.gated = enabled; }),
  setEndpointingMode: vi.fn((mode: 'silence' | 'indicate') => { voiceSettings.endpointingMode = mode; }),
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
    getLastMessage: vi.fn(() => null),
    getLastMessageFresh: vi.fn(async () => null),
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

async function simulateUtterance(
  pipeline: VoicePipeline,
  userId: string,
  transcript: string,
  durationMs = 500,
) {
  transcribeImpl = async () => transcript;
  const receiver = (pipeline as any).receiver;
  await receiver.simulateUtterance(userId, Buffer.from('fake-audio'), durationMs);
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
    voiceSettings = {
      gated: true,
      silenceThreshold: 0.01,
      silenceDuration: 1500,
      silenceDurationMs: 1500,
      speechThreshold: 500,
      minSpeechDurationMs: 300,
      endpointingMode: 'silence',
      indicateCloseWords: ["i'm done", "i'm finished", 'go ahead'],
      indicateTimeoutMs: 20000,
    };
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

  it('3.2b — indicate mode in queue captures across grace and enqueues on wake close', async () => {
    const { pipeline, qs } = makePipeline('queue');
    voiceSettings.endpointingMode = 'indicate';

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');

    await simulateUtterance(pipeline, 'user1', 'add milk to my list');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect(qs.enqueue).not.toHaveBeenCalled();

    await simulateUtterance(pipeline, 'user1', 'and eggs');
    expect(qs.enqueue).not.toHaveBeenCalled();

    await simulateUtterance(pipeline, 'user1', "Watson, I'm done");
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'add milk to my list and eggs',
      }),
    );
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.2c — indicate mode in queue treats bare switch command in grace as command, not dictation capture', async () => {
    const { pipeline, router } = makePipeline('queue');
    voiceSettings.endpointingMode = 'indicate';

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');
    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'user1', 'switch to health');

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(router.switchTo).toHaveBeenCalledWith('health');

    const listeningIdx = earconHistory.indexOf('listening');
    const acknowledgedIdx = earconHistory.indexOf('acknowledged');
    expect(listeningIdx).toBeGreaterThanOrEqual(0);
    expect(acknowledgedIdx).toBeGreaterThan(listeningIdx);

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

  // ── 3.6: Queue prompt during grace ────────────────────────────────────

  it('3.6 — utterance in queue mode during grace without wake word is enqueued', async () => {
    const { pipeline, qs } = makePipeline('queue');

    // First: wake check to open grace window
    await simulateUtterance(pipeline, 'user1', 'Watson');
    const enqueueBefore = qs.enqueue.mock.calls.length;
    earconHistory.length = 0;
    playerCalls.length = 0;

    // Now speak without wake word during grace in queue mode — should enqueue
    await simulateUtterance(pipeline, 'user1', 'add milk to my list');

    expect(qs.enqueue.mock.calls.length).toBe(enqueueBefore + 1);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'add milk to my list',
      }),
    );
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.7 — queue mode accepts immediate follow-up prompt after read-last-message', async () => {
    const { pipeline, qs, router } = makePipeline('queue');
    router.getLastMessageFresh.mockResolvedValue({
      role: 'assistant',
      content: 'Sleep score was down last night. Hydration looked good.',
    });

    await simulateUtterance(pipeline, 'user1', 'Watson, read the last message');

    const enqueueBefore = qs.enqueue.mock.calls.length;
    await simulateUtterance(
      pipeline,
      'user1',
      'compare that with the week average and tell me if there is any risk',
    );

    expect(qs.enqueue.mock.calls.length).toBe(enqueueBefore + 1);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'compare that with the week average and tell me if there is any risk',
      }),
    );

    pipeline.stop();
  });

  it('3.8 — read-last-message follow-up grace starts after ready cue', async () => {
    const { pipeline, router } = makePipeline('queue');
    router.getLastMessageFresh.mockResolvedValue({
      role: 'assistant',
      content: 'Long message body for readback.',
    });

    const order: string[] = [];
    const originalPlayReadyEarcon = (pipeline as any).playReadyEarcon.bind(pipeline);
    const originalAllowFollowupPromptGrace = (pipeline as any).allowFollowupPromptGrace.bind(pipeline);

    (pipeline as any).playReadyEarcon = vi.fn(async () => {
      order.push('ready:start');
      await originalPlayReadyEarcon();
      order.push('ready:end');
    });
    (pipeline as any).allowFollowupPromptGrace = vi.fn((ms: number) => {
      order.push('followup:set');
      return originalAllowFollowupPromptGrace(ms);
    });

    await simulateUtterance(pipeline, 'user1', 'Watson, read the last message');

    expect(order).toContain('ready:end');
    expect(order).toContain('followup:set');
    expect(order.indexOf('followup:set')).toBeGreaterThan(order.indexOf('ready:end'));

    pipeline.stop();
  });

  it('3.9 — long follow-up utterance is accepted when it starts inside follow-up grace', async () => {
    const { pipeline, qs, router } = makePipeline('queue');
    router.getLastMessageFresh.mockResolvedValue({
      role: 'assistant',
      content: 'Long message body for readback.',
    });

    await simulateUtterance(pipeline, 'user1', 'Watson, read the last message');
    const enqueueBefore = qs.enqueue.mock.calls.length;

    // Simulate tail-end capture: grace timestamp is slightly in the past at
    // capture time, but the utterance start (capture minus duration) is still
    // within the grace+tolerance window.
    const now = Date.now();
    (pipeline as any).ctx.followupPromptGraceUntil = now - 200;
    (pipeline as any).ctx.gateGraceUntil = now + 2000;

    await simulateUtterance(
      pipeline,
      'user1',
      'what did my calorie deficit end up looking like with actual numbers',
      1200,
    );

    expect(qs.enqueue.mock.calls.length).toBe(enqueueBefore + 1);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
      }),
    );

    pipeline.stop();
  });

  it('3.10 — channel switch handoff allows one immediate follow-up prompt', async () => {
    const { pipeline, qs } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Watson, switch to walmart');
    const enqueueBefore = qs.enqueue.mock.calls.length;

    await simulateUtterance(
      pipeline,
      'user1',
      'what did my calorie deficit end up looking like with actual numbers',
      1400,
    );

    expect(qs.enqueue.mock.calls.length).toBe(enqueueBefore + 1);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
      }),
    );

    pipeline.stop();
  });

  it('3.11 — bare "scratch to" switch is treated as a switch command', async () => {
    const { pipeline, router, qs } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Watson');
    await simulateUtterance(pipeline, 'user1', 'scratch to walmart');

    expect(router.switchTo).toHaveBeenCalledWith('walmart');
    expect(qs.enqueue).not.toHaveBeenCalled();

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
