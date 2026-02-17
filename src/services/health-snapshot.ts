export interface HealthCounters {
  utterancesProcessed: number;
  commandsRecognized: number;
  llmDispatches: number;
  errors: number;
  sttFailures: number;
  ttsFailures: number;
  invariantViolations: number;
  stallWatchdogFires: number;
}

export interface HealthSnapshot {
  pipelineState: string;
  pipelineStateAge: number;
  uptime: number;
  mode: string;
  activeChannel: string | null;
  queueReady: number;
  queuePending: number;
  gatewayConnected: boolean;
  dependencies: {
    whisper: 'up' | 'down' | 'unknown';
    tts: 'up' | 'down' | 'unknown';
  };
  counters: HealthCounters;
}

export function createHealthCounters(): HealthCounters {
  return {
    utterancesProcessed: 0,
    commandsRecognized: 0,
    llmDispatches: 0,
    errors: 0,
    sttFailures: 0,
    ttsFailures: 0,
    invariantViolations: 0,
    stallWatchdogFires: 0,
  };
}
