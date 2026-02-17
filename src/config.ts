import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  openaiApiKey: process.env['OPENAI_API_KEY'] || '',
  whisperUrl: process.env['WHISPER_URL'] || '',
  gatewayUrl: process.env['GATEWAY_URL'] || 'http://localhost:18789',
  gatewayToken: required('GATEWAY_TOKEN'),
  gatewayAgentId: process.env['GATEWAY_AGENT_ID'] || 'main',
  ttsBackend: process.env['TTS_BACKEND'] || 'elevenlabs',
  ttsFallbackBackend: process.env['TTS_FALLBACK_BACKEND'] || '',
  ttsPrimaryRetryMs: parseInt(process.env['TTS_PRIMARY_RETRY_MS'] || '30000', 10),
  elevenLabsApiKey: process.env['ELEVENLABS_API_KEY'] || '',
  elevenLabsVoiceId: process.env['ELEVENLABS_VOICE_ID'] || 'JBFqnCBsd6RMkjVDRZzb',
  kokoroUrl: process.env['KOKORO_URL'] || 'http://127.0.0.1:8880',
  kokoroVoice: process.env['KOKORO_VOICE'] || 'af_bella',
  chatterboxUrl: process.env['CHATTERBOX_URL'] || 'http://127.0.0.1:4123',
  chatterboxVoice: process.env['CHATTERBOX_VOICE'] || 'default',
  earconMinGapMs: Math.max(0, parseInt(process.env['EARCON_MIN_GAP_MS'] || '500', 10)),
  discordGuildId: required('DISCORD_GUILD_ID'),
  discordVoiceChannelId: required('DISCORD_VOICE_CHANNEL_ID'),
  silenceDurationMs: parseInt(process.env['SILENCE_DURATION_MS'] || '500', 10),
  speechThreshold: parseInt(process.env['SPEECH_THRESHOLD'] || '500', 10),
  minSpeechDurationMs: parseInt(process.env['MIN_SPEECH_DURATION_MS'] || '600', 10),
  botName: process.env['BOT_NAME'] || 'Assistant',
  logChannelId: process.env['LOG_CHANNEL_ID'] || '',
  utilityChannelId: process.env['UTILITY_CHANNEL_ID'] || '1471563603625775124',
  sessionsDir: process.env['SESSIONS_DIR'] || `${process.env['HOME']}/.clawdbot/agents/main/sessions`,
  gatewayWsEnabled: process.env['GATEWAY_WS_SYNC'] !== 'false',
  dependencyHealthcheckMs: parseInt(process.env['DEPENDENCY_HEALTHCHECK_MS'] || '15000', 10),
  dependencyAutoRestart: process.env['DEPENDENCY_AUTO_RESTART'] === 'true',
  whisperRestartCommand: process.env['WHISPER_RESTART_COMMAND'] || '',
  kokoroRestartCommand: process.env['KOKORO_RESTART_COMMAND'] || '',
  chatterboxRestartCommand: process.env['CHATTERBOX_RESTART_COMMAND'] || '',
};

if (!config.whisperUrl && !config.openaiApiKey) {
  throw new Error('At least one STT backend required: set WHISPER_URL (local) or OPENAI_API_KEY (cloud)');
}
