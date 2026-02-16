/**
 * Layer 4: Ask Mode Tests
 *
 * Verifies ask mode (speculative dispatch + choice):
 *   - Happy path → inbox, wait, silent, cancel
 *   - Timeout and timeout warning
 *   - Navigation command during choice
 *   - Unrecognized input → reprompt
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

function makeQueueState(mode: 'wait' | 'queue' | 'ask' = 'ask') {
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
    listChannels: vi.fn(() => [
      { name: 'walmart', displayName: 'Walmart' },
      { name: 'health', displayName: 'Health' },
    ]),
    getLogChannel: vi.fn(async () => null),
    getLogChannelFor: vi.fn(async () => null),
    getAllChannelSessionKeys: vi.fn(() => []),
    findForumChannel: vi.fn(() => null),
    listForumChannels: vi.fn(() => []),
    getForumThreads: vi.fn(async () => []),
    switchTo: vi.fn(async (target: string) => {
      const channels = [
        { name: 'walmart', displayName: 'Walmart' },
        { name: 'health', displayName: 'Health' },
      ];
      const ch = channels.find((c) => c.name === target);
      return ch ? { success: true, displayName: ch.displayName } : { success: false, displayName: target };
    }),
    switchToDefault: vi.fn(async () => ({ success: true, displayName: 'Walmart' })),
    createForumPost: vi.fn(async () => ({ success: false, error: 'not implemented' })),
  };
}

function makeResponsePoller() {
  return { check: vi.fn() };
}

function makePipeline(mode: 'wait' | 'queue' | 'ask' = 'ask') {
  const pipeline = new VoicePipeline({} as any);
  const qs = makeQueueState(mode);
  const router = makeRouter();
  const poller = makeResponsePoller();

  pipeline.setQueueState(qs as any);
  pipeline.setRouter(router as any);
  pipeline.setResponsePoller(poller as any);

  return { pipeline, qs, router, poller };
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

describe('Layer 4: Ask Mode Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerCalls.length = 0;
    voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'LLM response.', history: [] });
    ttsStreamImpl = async () => Buffer.from('tts-audio');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 4.1: Ask mode happy path → inbox ─────────────────────────────────

  it('4.1 — ask mode prompt enters choice, user says "inbox" → queued confirmation', async () => {
    const { pipeline, qs } = makePipeline('ask');

    // Stage 1: User speaks prompt — enters ask mode
    await simulateUtterance(pipeline, 'Watson, add milk to my list');

    // Should have enqueued speculatively
    expect(qs.enqueue).toHaveBeenCalled();
    // Should be in AWAITING_QUEUE_CHOICE
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');
    // Should have spoken "Send to inbox, or wait here?"
    expect(playerCalls).toContain('playStream');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Stage 2: User says "inbox" — confirms queue
    await simulateUtterance(pipeline, 'inbox');
    await new Promise((r) => setTimeout(r, 300));

    expect(earconHistory).toContain('acknowledged');
    expect(playerCalls).toContain('playStream'); // speaks "Queued to Walmart."
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 4.2: Ask mode → wait ─────────────────────────────────────────────

  it('4.2 — ask mode → "wait" with ready response delivers immediately', async () => {
    const { pipeline, qs } = makePipeline('ask');
    // Make LLM response complete very fast
    getResponseImpl = async () => ({ response: 'Fast response.', history: [] });

    // Stage 1: Prompt enters ask mode
    await simulateUtterance(pipeline, 'Watson, tell me about cats');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    // Allow speculative dispatch to complete
    await new Promise((r) => setTimeout(r, 100));

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Stage 2: User says "wait" — response should already be ready
    await simulateUtterance(pipeline, 'wait');
    await new Promise((r) => setTimeout(r, 300));

    // Should have spoken the response
    expect(playerCalls).toContain('playStream');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('4.2b — ask mode → "wait" with pending response starts waiting loop and sets callback', async () => {
    const { pipeline, qs } = makePipeline('ask');
    // Make LLM take a long time
    let resolveLLM: ((val: { response: string; history: any[] }) => void) | null = null;
    getResponseImpl = () => new Promise((resolve) => { resolveLLM = resolve; });

    // Stage 1: Prompt enters ask mode
    await simulateUtterance(pipeline, 'Watson, tell me about cats');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Stage 2: User says "wait" — response not ready yet
    await simulateUtterance(pipeline, 'wait');
    await new Promise((r) => setTimeout(r, 200));

    // Should have started the waiting loop
    expect(playerCalls).toContain('startWaitingLoop');
    // The finally block in handleUtterance resets to IDLE, but the
    // pendingWaitCallback is set to deliver when ready
    expect(getState(pipeline)).toBe('IDLE');
    expect((pipeline as any).ctx.pendingWaitCallback).not.toBeNull();

    // Now resolve the LLM
    resolveLLM?.({ response: 'Delayed response.', history: [] });
    await new Promise((r) => setTimeout(r, 100));

    pipeline.stop();
  });

  // ── 4.3: Ask mode → silent ───────────────────────────────────────────

  it('4.3 — ask mode → "silent" sets silentWait and plays acknowledged', async () => {
    const { pipeline, qs } = makePipeline('ask');

    await simulateUtterance(pipeline, 'Watson, add eggs to my list');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'silent');
    await new Promise((r) => setTimeout(r, 100));

    expect(earconHistory).toContain('acknowledged');
    expect((pipeline as any).ctx.silentWait).toBe(true);
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 4.4: Ask mode → cancel ──────────────────────────────────────────

  it('4.4 — ask mode → "cancel" triggers reprompt (cancel not directly handled)', async () => {
    const { pipeline } = makePipeline('ask');

    await simulateUtterance(pipeline, 'Watson, add butter');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // "cancel" falls through matchQueueChoice → else block → reprompt
    await simulateUtterance(pipeline, 'cancel');
    await new Promise((r) => setTimeout(r, 100));

    // Still in awaiting state after reprompt
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    pipeline.stop();
  });

  // ── 4.5: Ask mode → timeout ──────────────────────────────────────────

  it('4.5 — ask mode choice times out after configured duration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { pipeline } = makePipeline('ask');

    // Enter ask mode
    await simulateUtterance(pipeline, 'Watson, add butter');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Advance to timeout (20s)
    await vi.advanceTimersByTimeAsync(20_100);

    expect(earconHistory).toContain('cancelled');
    expect(playerCalls).toContain('playStream'); // "Choice timed out."
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 4.6: Ask mode → navigation command instead of choice ─────────────

  it('4.6 — navigation command during ask choice switches channel', async () => {
    const { pipeline, router } = makePipeline('ask');

    await simulateUtterance(pipeline, 'Watson, add butter');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Say a switch command (with wake word)
    await simulateUtterance(pipeline, 'Watson, switch to health');
    await new Promise((r) => setTimeout(r, 300));

    expect(router.switchTo).toHaveBeenCalledWith('health');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 4.7: Ask mode → unrecognized input ───────────────────────────────

  it('4.7 — unrecognized input during ask choice triggers reprompt', async () => {
    const { pipeline } = makePipeline('ask');

    await simulateUtterance(pipeline, 'Watson, add butter');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Say something that doesn't match any choice
    await simulateUtterance(pipeline, 'peanut butter and jelly');
    await new Promise((r) => setTimeout(r, 100));

    // Should reprompt — still in AWAITING
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');
    // Reprompt plays TTS
    expect(playerCalls).toContain('playStream');

    pipeline.stop();
  });

  // ── 4.8: Ask mode → timeout warning fires before timeout ──────────────

  it('4.8 — timeout warning fires before timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { pipeline } = makePipeline('ask');

    await simulateUtterance(pipeline, 'Watson, add butter');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    earconHistory.length = 0;

    // Advance to warning time (15s = 20s - 5s)
    await vi.advanceTimersByTimeAsync(15_100);

    expect(earconHistory).toContain('timeout-warning');
    // Should still be in AWAITING (not timed out yet)
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    pipeline.stop();
  });

  // ── Speculative dispatch counter ─────────────────────────────────────

  it('ask mode increments llmDispatches counter', async () => {
    const { pipeline } = makePipeline('ask');
    getResponseImpl = async () => ({ response: 'Done.', history: [] });

    await simulateUtterance(pipeline, 'Watson, add butter');
    // Allow dispatch to fire
    await new Promise((r) => setTimeout(r, 50));

    expect(pipeline.getCounters().llmDispatches).toBeGreaterThanOrEqual(1);

    pipeline.stop();
  });

  // ── Ask mode with "yes" and "no" variants ────────────────────────────

  it('"yes" during ask choice maps to inbox', async () => {
    const { pipeline, qs } = makePipeline('ask');

    await simulateUtterance(pipeline, 'Watson, add eggs');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');

    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'yes');
    await new Promise((r) => setTimeout(r, 300));

    expect(earconHistory).toContain('acknowledged');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('"no" during ask choice maps to wait', async () => {
    const { pipeline } = makePipeline('ask');
    getResponseImpl = async () => ({ response: 'Fast.', history: [] });

    await simulateUtterance(pipeline, 'Watson, add eggs');
    expect(getState(pipeline)).toBe('AWAITING_QUEUE_CHOICE');
    await new Promise((r) => setTimeout(r, 100)); // Let speculative dispatch finish

    await simulateUtterance(pipeline, 'no');
    await new Promise((r) => setTimeout(r, 300));

    // "no" → wait → should deliver response
    expect(playerCalls.filter((c) => c === 'playStream').length).toBeGreaterThanOrEqual(2);
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });
});
