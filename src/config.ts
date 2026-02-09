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
  elevenLabsApiKey: required('ELEVENLABS_API_KEY'),
  elevenLabsVoiceId: process.env['ELEVENLABS_VOICE_ID'] || 'JBFqnCBsd6RMkjVDRZzb',
  discordGuildId: required('DISCORD_GUILD_ID'),
  discordVoiceChannelId: required('DISCORD_VOICE_CHANNEL_ID'),
  silenceDurationMs: parseInt(process.env['SILENCE_DURATION_MS'] || '1500', 10),
  speechThreshold: parseInt(process.env['SPEECH_THRESHOLD'] || '500', 10),
  minSpeechDurationMs: parseInt(process.env['MIN_SPEECH_DURATION_MS'] || '300', 10),
  botName: process.env['BOT_NAME'] || 'Assistant',
  logChannelId: process.env['LOG_CHANNEL_ID'] || '',
  sessionsDir: process.env['SESSIONS_DIR'] || `${process.env['HOME']}/.clawdbot/agents/main/sessions`,
};

if (!config.whisperUrl && !config.openaiApiKey) {
  throw new Error('At least one STT backend required: set WHISPER_URL (local) or OPENAI_API_KEY (cloud)');
}
