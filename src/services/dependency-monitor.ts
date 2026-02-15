import { config } from '../config.js';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

const execAsync = promisify(execCb);

type DependencyKey = 'whisper' | 'tts';
type TtsBackend = 'kokoro' | 'chatterbox' | 'elevenlabs';

export interface DependencyStatus {
  whisperUp: boolean;
  ttsUp: boolean;
}

export class DependencyMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastStatus: DependencyStatus | null = null;
  private restartCooldownUntil: Record<DependencyKey, number> = {
    whisper: 0,
    tts: 0,
  };

  constructor(
    private readonly onStatusChange: (status: DependencyStatus, previous: DependencyStatus | null) => void,
  ) {}

  start(): void {
    this.stop();
    void this.checkOnce();
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, Math.max(5_000, config.dependencyHealthcheckMs));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkOnce(): Promise<DependencyStatus> {
    const status = await this.checkDependencies();
    const changed =
      !this.lastStatus ||
      this.lastStatus.whisperUp !== status.whisperUp ||
      this.lastStatus.ttsUp !== status.ttsUp;

    if (changed) {
      const previous = this.lastStatus;
      this.lastStatus = status;
      this.onStatusChange(status, previous);
    } else {
      this.lastStatus = status;
    }

    return status;
  }

  private async checkDependencies(): Promise<DependencyStatus> {
    const whisperUp = config.whisperUrl ? await this.checkEndpoint(config.whisperUrl) : true;
    const tts = await this.checkTtsEndpoint();
    const ttsUp = tts.anyUp;

    if (!whisperUp) {
      await this.maybeRestart('whisper');
    }
    // If primary TTS is down, try to recover it even if fallback is up.
    if (!tts.primaryUp) {
      await this.maybeRestart('tts');
    }

    return { whisperUp, ttsUp };
  }

  private async checkTtsEndpoint(): Promise<{ primaryUp: boolean; anyUp: boolean }> {
    const primary = this.parseBackend(config.ttsBackend);
    const fallback = this.parseBackend(config.ttsFallbackBackend);
    const checks: boolean[] = [];
    let primaryUp = true;

    if (primary === 'kokoro') {
      primaryUp = await this.checkEndpoint(config.kokoroUrl);
      checks.push(primaryUp);
    } else if (primary === 'chatterbox') {
      primaryUp = await this.checkEndpoint(config.chatterboxUrl);
      checks.push(primaryUp);
    } else {
      primaryUp = true;
      checks.push(true);
    }

    if (fallback && fallback !== primary) {
      if (fallback === 'kokoro') checks.push(await this.checkEndpoint(config.kokoroUrl));
      else if (fallback === 'chatterbox') checks.push(await this.checkEndpoint(config.chatterboxUrl));
      else checks.push(true);
    }

    return { primaryUp, anyUp: checks.some(Boolean) };
  }

  private async checkEndpoint(rawUrl: string): Promise<boolean> {
    try {
      const parsed = new URL(rawUrl);
      const port = parsed.port
        ? parseInt(parsed.port, 10)
        : parsed.protocol === 'https:'
          ? 443
          : 80;
      return await this.checkTcp(parsed.hostname, port, 1200);
    } catch {
      return false;
    }
  }

  private checkTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  private async maybeRestart(dep: DependencyKey): Promise<void> {
    if (!config.dependencyAutoRestart) return;
    const now = Date.now();
    if (now < this.restartCooldownUntil[dep]) return;
    this.restartCooldownUntil[dep] = now + 60_000;

    const restartCommand = this.getRestartCommand(dep);
    if (!restartCommand) return;

    try {
      console.warn(`Dependency monitor: restarting ${dep} with configured command`);
      await execAsync(restartCommand, { timeout: 20_000, shell: '/bin/zsh' });
    } catch (err: any) {
      console.warn(`Dependency monitor: restart command failed for ${dep}: ${err?.message ?? err}`);
    }
  }

  private getRestartCommand(dep: DependencyKey): string {
    if (dep === 'whisper') return config.whisperRestartCommand;
    if (config.ttsBackend === 'kokoro') return config.kokoroRestartCommand;
    if (config.ttsBackend === 'chatterbox') return config.chatterboxRestartCommand;
    return '';
  }

  private parseBackend(raw: string): TtsBackend | null {
    const value = raw.trim().toLowerCase();
    if (value === 'kokoro' || value === 'chatterbox' || value === 'elevenlabs') {
      return value;
    }
    return null;
  }
}
