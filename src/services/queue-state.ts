import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type VoiceMode = 'wait' | 'queue' | 'ask';

export interface QueuedResponse {
  id: string;
  channel: string;
  displayName: string;
  sessionKey: string;
  userMessage: string;
  summary: string;
  responseText: string;
  timestamp: number;
  status: 'pending' | 'ready' | 'heard';
}

interface QueueStateData {
  mode: VoiceMode;
  items: QueuedResponse[];
  channelSnapshots?: Record<string, number>;
}

const STATE_PATH = `${process.env['HOME']}/clawd/voice-queue-state.json`;

export class QueueState {
  private mode: VoiceMode = 'wait';
  private items: QueuedResponse[] = [];
  private channelSnapshots: Record<string, number> = {};

  constructor() {
    this.load();
  }

  getMode(): VoiceMode {
    return this.mode;
  }

  setMode(mode: VoiceMode): void {
    this.mode = mode;
    this.save();
  }

  enqueue(params: {
    channel: string;
    displayName: string;
    sessionKey: string;
    userMessage: string;
  }): QueuedResponse {
    const item: QueuedResponse = {
      id: randomUUID(),
      channel: params.channel,
      displayName: params.displayName,
      sessionKey: params.sessionKey,
      userMessage: params.userMessage,
      summary: '',
      responseText: '',
      timestamp: Date.now(),
      status: 'pending',
    };
    this.items.push(item);
    this.save();
    return item;
  }

  markReady(id: string, summary: string, responseText: string): void {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.status = 'ready';
      item.summary = summary;
      item.responseText = responseText;
      this.save();
    }
  }

  markHeard(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.status = 'heard';
      this.save();
    }
  }

  getReadyItems(): QueuedResponse[] {
    return this.items.filter((i) => i.status === 'ready');
  }

  getPendingItems(): QueuedResponse[] {
    return this.items.filter((i) => i.status === 'pending');
  }

  getNextReady(): QueuedResponse | null {
    // Oldest ready item first
    return this.items.find((i) => i.status === 'ready') ?? null;
  }

  getReadyByChannel(channel: string): QueuedResponse | null {
    return this.items.find((i) => i.status === 'ready' && i.channel === channel) ?? null;
  }

  getSnapshots(): Record<string, number> {
    return { ...this.channelSnapshots };
  }

  setSnapshots(snapshots: Record<string, number>): void {
    this.channelSnapshots = { ...snapshots };
    this.save();
  }

  clearSnapshots(): void {
    this.channelSnapshots = {};
    this.save();
  }

  private load(): void {
    try {
      const raw = readFileSync(STATE_PATH, 'utf-8');
      const data: QueueStateData = JSON.parse(raw);
      this.mode = data.mode || 'ask';
      this.items = data.items || [];
      this.channelSnapshots = data.channelSnapshots || {};
    } catch {
      // File doesn't exist or is corrupt — start fresh
      this.mode = 'ask';
      this.items = [];
      this.channelSnapshots = {};
    }
  }

  private save(): void {
    const data: QueueStateData = { mode: this.mode, items: this.items, channelSnapshots: this.channelSnapshots };
    try {
      mkdirSync(dirname(STATE_PATH), { recursive: true });
      writeFileSync(STATE_PATH, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`Failed to save queue state: ${err.message}`);
    }
  }
}
