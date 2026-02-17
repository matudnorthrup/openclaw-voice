/**
 * Layer 10: Health & Monitoring Tests
 *
 * Counters, snapshots, health monitor alerts.
 *   10.1  Counter accuracy after known operations
 *   10.2  Health snapshot reflects real state
 *   10.3  Health monitor dependency alert
 *   10.4  Health monitor stall alert
 *   10.5  Health monitor error rate spike alert
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Service mocks (pipeline tests) ──────────────────────────────────────

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
import { HealthMonitor } from '../src/services/health-monitor.js';
import type { HealthSnapshot } from '../src/services/health-snapshot.js';
import { createHealthCounters } from '../src/services/health-snapshot.js';

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

function makeBaseSnapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    pipelineState: 'IDLE',
    pipelineStateAge: 100,
    uptime: 60_000,
    mode: 'wait',
    activeChannel: 'walmart',
    queueReady: 0,
    queuePending: 0,
    gatewayConnected: true,
    dependencies: { whisper: 'up', tts: 'up' },
    counters: createHealthCounters(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Layer 10: Health & Monitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerCalls.length = 0;
    voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'LLM response.', history: [] });
  });

  // ── 10.1: Counter accuracy ──────────────────────────────────────────

  it('10.1 — counters track utterances and commands accurately', async () => {
    const { pipeline } = makePipeline();
    const before = pipeline.getCounters();
    expect(before.utterancesProcessed).toBe(0);
    expect(before.commandsRecognized).toBe(0);

    // Process a regular prompt (utterance + LLM dispatch)
    await simulateUtterance(pipeline, 'Watson, hello there');
    await new Promise((r) => setTimeout(r, 50));

    const after1 = pipeline.getCounters();
    expect(after1.utterancesProcessed).toBe(1);

    // Process a voice command
    await simulateUtterance(pipeline, 'Watson, voice status');

    const after2 = pipeline.getCounters();
    expect(after2.utterancesProcessed).toBe(2);
    expect(after2.commandsRecognized).toBeGreaterThanOrEqual(1);

    pipeline.stop();
  });

  // ── 10.2: Health snapshot ───────────────────────────────────────────

  it('10.2 — health snapshot reflects pipeline state', async () => {
    const { pipeline } = makePipeline();

    const snapshot = pipeline.getHealthSnapshot();

    expect(snapshot.pipelineState).toBe('IDLE');
    expect(snapshot.uptime).toBeGreaterThanOrEqual(0);
    expect(snapshot.mode).toBe('wait');
    expect(snapshot.activeChannel).toBe('walmart');
    expect(snapshot.queueReady).toBe(0);
    expect(snapshot.queuePending).toBe(0);
    expect(snapshot.dependencies).toEqual({ whisper: 'unknown', tts: 'unknown' });
    expect(snapshot.counters).toBeDefined();
    expect(snapshot.counters.utterancesProcessed).toBe(0);

    pipeline.stop();
  });

  // ── 10.3: Health monitor dependency alert ───────────────────────────

  it('10.3 — health monitor posts alert when dependency goes down', async () => {
    let callCount = 0;
    const getSnapshot = vi.fn(() => {
      callCount++;
      if (callCount <= 1) {
        return makeBaseSnapshot({ dependencies: { whisper: 'up', tts: 'up' } });
      }
      // Second call: whisper goes down
      return makeBaseSnapshot({ dependencies: { whisper: 'down', tts: 'up' } });
    });

    const logChannel = {
      send: vi.fn(async () => ({})),
    };

    const monitor = new HealthMonitor({
      getSnapshot,
      logChannel: logChannel as any,
      intervalMs: 50,
    });

    monitor.start();

    // Wait for at least one check cycle
    await new Promise((r) => setTimeout(r, 120));

    monitor.stop();

    expect(logChannel.send).toHaveBeenCalled();
    const sentMessage = logChannel.send.mock.calls[0][0];
    expect(sentMessage).toContain('Health Alert');
    expect(sentMessage).toContain('Whisper');
    expect(sentMessage).toContain('down');
  });

  // ── 10.4: Health monitor stall alert ────────────────────────────────

  it('10.4 — health monitor posts alert when stall watchdog fires', async () => {
    let callCount = 0;
    const getSnapshot = vi.fn(() => {
      callCount++;
      if (callCount <= 1) {
        return makeBaseSnapshot();
      }
      // Second call: stall watchdog fired
      const counters = createHealthCounters();
      counters.stallWatchdogFires = 1;
      return makeBaseSnapshot({ counters });
    });

    const logChannel = {
      send: vi.fn(async () => ({})),
    };

    const monitor = new HealthMonitor({
      getSnapshot,
      logChannel: logChannel as any,
      intervalMs: 50,
    });

    monitor.start();

    await new Promise((r) => setTimeout(r, 120));

    monitor.stop();

    expect(logChannel.send).toHaveBeenCalled();
    const sentMessage = logChannel.send.mock.calls[0][0];
    expect(sentMessage).toContain('Health Alert');
    expect(sentMessage).toContain('Stall watchdog');
  });

  // ── 10.5: Health monitor error rate spike alert ─────────────────────

  it('10.5 — health monitor posts alert on error rate spike', async () => {
    let callCount = 0;
    const getSnapshot = vi.fn(() => {
      callCount++;
      if (callCount <= 1) {
        return makeBaseSnapshot();
      }
      // Second call: 3 errors accumulated
      const counters = createHealthCounters();
      counters.errors = 3;
      return makeBaseSnapshot({ counters });
    });

    const logChannel = {
      send: vi.fn(async () => ({})),
    };

    const monitor = new HealthMonitor({
      getSnapshot,
      logChannel: logChannel as any,
      intervalMs: 50,
    });

    monitor.start();

    await new Promise((r) => setTimeout(r, 120));

    monitor.stop();

    expect(logChannel.send).toHaveBeenCalled();
    const sentMessage = logChannel.send.mock.calls[0][0];
    expect(sentMessage).toContain('Health Alert');
    expect(sentMessage).toContain('Error spike');
  });
});
