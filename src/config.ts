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
  openaiApiKey: required('OPENAI_API_KEY'),
  gatewayUrl: process.env['GATEWAY_URL'] || 'http://localhost:18789',
  gatewayToken: required('GATEWAY_TOKEN'),
  gatewayAgentId: process.env['GATEWAY_AGENT_ID'] || 'main',
  elevenLabsApiKey: required('ELEVENLABS_API_KEY'),
  elevenLabsVoiceId: process.env['ELEVENLABS_VOICE_ID'] || 'JBFqnCBsd6RMkjVDRZzb',
  discordGuildId: required('DISCORD_GUILD_ID'),
  discordVoiceChannelId: required('DISCORD_VOICE_CHANNEL_ID'),
  silenceDurationMs: parseInt(process.env['SILENCE_DURATION_MS'] || '1500', 10),
  logChannelId: process.env['LOG_CHANNEL_ID'] || '',
  sessionsDir: process.env['SESSIONS_DIR'] || `${process.env['HOME']}/.clawdbot/agents/main/sessions`,
};
