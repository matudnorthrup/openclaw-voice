import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const SESSION_VERSION = 3;

/**
 * Writes voice conversation transcripts as JSONL session files
 * in the same format as OpenClaw, so the QMD manager picks them
 * up for Obsidian export and the working-state-capture monitor
 * detects activity.
 */
export class SessionTranscript {
  private sessionId: string;
  private filePath: string;
  private lastMessageId: string;
  private initialized = false;

  constructor() {
    this.sessionId = randomUUID();
    this.lastMessageId = '';

    if (!existsSync(config.sessionsDir)) {
      mkdirSync(config.sessionsDir, { recursive: true });
    }

    this.filePath = `${config.sessionsDir}/voice-${this.sessionId}.jsonl`;
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    const header = {
      type: 'session',
      version: SESSION_VERSION,
      id: this.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    this.appendLine(header);
    console.log(`Session transcript: ${this.filePath}`);
  }

  appendUserMessage(userId: string, text: string, channelName?: string): void {
    this.ensureInitialized();
    const id = randomUUID().slice(0, 8);
    const entry: Record<string, unknown> = {
      type: 'message',
      id,
      parentId: this.lastMessageId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: `[voice:${userId}] ${text}` }],
        timestamp: Date.now(),
      },
    };
    if (channelName) entry.channel = channelName;
    this.appendLine(entry);
    this.lastMessageId = id;
  }

  appendAssistantMessage(text: string, channelName?: string): void {
    this.ensureInitialized();
    const id = randomUUID().slice(0, 8);
    const entry: Record<string, unknown> = {
      type: 'message',
      id,
      parentId: this.lastMessageId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      },
    };
    if (channelName) entry.channel = channelName;
    this.appendLine(entry);
    this.lastMessageId = id;
  }

  private appendLine(obj: Record<string, unknown>): void {
    appendFileSync(this.filePath, JSON.stringify(obj) + '\n');
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getFilePath(): string {
    return this.filePath;
  }
}
