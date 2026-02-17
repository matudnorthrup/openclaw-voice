import type { TextChannel } from 'discord.js';
import type { HealthSnapshot } from './health-snapshot.js';

export interface HealthMonitorOptions {
  getSnapshot: () => HealthSnapshot;
  logChannel: TextChannel | null;
  intervalMs?: number;
}

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private previousSnapshot: HealthSnapshot | null = null;
  private readonly getSnapshot: () => HealthSnapshot;
  private readonly logChannel: TextChannel | null;
  private readonly intervalMs: number;

  constructor(options: HealthMonitorOptions) {
    this.getSnapshot = options.getSnapshot;
    this.logChannel = options.logChannel;
    this.intervalMs = options.intervalMs ?? 120_000;
  }

  start(): void {
    this.stop();
    this.previousSnapshot = this.getSnapshot();
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.previousSnapshot = null;
  }

  private check(): void {
    const current = this.getSnapshot();
    const prev = this.previousSnapshot;
    const alerts: string[] = [];

    if (prev) {
      // Dependency transitions
      if (prev.dependencies.whisper === 'up' && current.dependencies.whisper === 'down') {
        alerts.push('STT (Whisper) went **down**');
      } else if (prev.dependencies.whisper === 'down' && current.dependencies.whisper === 'up') {
        alerts.push('STT (Whisper) is back **up**');
      }
      if (prev.dependencies.tts === 'up' && current.dependencies.tts === 'down') {
        alerts.push('TTS went **down**');
      } else if (prev.dependencies.tts === 'down' && current.dependencies.tts === 'up') {
        alerts.push('TTS is back **up**');
      }

      // Stall watchdog fired since last check
      const newStalls = current.counters.stallWatchdogFires - prev.counters.stallWatchdogFires;
      if (newStalls > 0) {
        alerts.push(`Stall watchdog fired **${newStalls}** time(s)`);
      }

      // Invariant violations since last check
      const newViolations = current.counters.invariantViolations - prev.counters.invariantViolations;
      if (newViolations > 0) {
        alerts.push(`**${newViolations}** invariant violation(s) detected`);
      }

      // Error rate spike (>=3 errors in period)
      const newErrors = current.counters.errors - prev.counters.errors;
      if (newErrors >= 3) {
        alerts.push(`Error spike: **${newErrors}** errors in last check period`);
      }

      // Pipeline stuck in non-IDLE for >2 minutes
      if (current.pipelineState !== 'IDLE' && current.pipelineStateAge > 120_000) {
        alerts.push(`Pipeline stuck in **${current.pipelineState}** for ${Math.round(current.pipelineStateAge / 1000)}s`);
      }
    }

    this.previousSnapshot = current;

    if (alerts.length > 0 && this.logChannel) {
      const message = `**Health Alert:**\n${alerts.map((a) => `- ${a}`).join('\n')}`;
      this.logChannel.send(message).catch((err) => {
        console.warn(`Health monitor alert failed: ${err.message}`);
      });
    }
  }
}
