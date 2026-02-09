import { config } from './config.js';
import { createClient } from './discord/client.js';
import { joinChannel, leaveChannel, getConnection, setConnection } from './discord/voice-connection.js';
import { VoicePipeline } from './pipeline/voice-pipeline.js';
import { clearConversation } from './services/claude.js';
import { ChannelRouter } from './services/channel-router.js';
import { initVoiceSettings, getVoiceSettings, setSilenceDuration, setSpeechThreshold, resolveNoiseLevel, getNoisePresetNames } from './services/voice-settings.js';
import { VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { ChannelType, TextChannel, VoiceState, SlashCommandBuilder, REST, Routes, ChatInputCommandInteraction, GuildMember } from 'discord.js';

console.log(`${config.botName} Voice starting...`);

initVoiceSettings({
  silenceDurationMs: config.silenceDurationMs,
  speechThreshold: config.speechThreshold,
  minSpeechDurationMs: config.minSpeechDurationMs,
});

const client = createClient();
let pipeline: VoicePipeline | null = null;
let router: ChannelRouter | null = null;
let leaveTimeout: ReturnType<typeof setTimeout> | null = null;

// --- Text command handlers ---

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '~join') {
    await handleJoin(message.guild!.id, message);
  } else if (message.content === '~leave') {
    handleLeave();
    await message.reply('Left voice channel.');
  } else if (message.content === '~clear') {
    clearConversation(message.author.id);
    if (router) {
      router.clearActiveHistory();
    }
    await message.reply('Conversation cleared.');
  } else if (message.content === '~channels') {
    if (!router) {
      await message.reply('Not connected to voice. Use `~join` first.');
      return;
    }
    const list = router.listChannels();
    const lines = list.map((ch) =>
      `${ch.active ? '> ' : '  '} **${ch.name}** — ${ch.displayName}${ch.active ? ' (active)' : ''}`,
    );
    await message.reply(`Available channels:\n${lines.join('\n')}`);
  } else if (message.content.startsWith('~switch ')) {
    if (!router || !pipeline) {
      await message.reply('Not connected to voice. Use `~join` first.');
      return;
    }
    const name = message.content.slice('~switch '.length).trim();
    const result = await router.switchTo(name.toLowerCase());
    if (!result.success) {
      await message.reply(result.error!);
      return;
    }
    await pipeline.onChannelSwitch();
    const label = result.displayName || name;
    await message.reply(`Switched to **${label}**. Loaded ${result.historyCount} history messages.`);
  } else if (message.content === '~default') {
    if (!router || !pipeline) {
      await message.reply('Not connected to voice. Use `~join` first.');
      return;
    }
    const result = await router.switchToDefault();
    await pipeline.onChannelSwitch();
    await message.reply(`Switched back to **default** channel. Loaded ${result.historyCount} history messages.`);
  } else if (message.content === '~voice') {
    const s = getVoiceSettings();
    await message.reply(
      `**Voice settings:**\n` +
      `  Silence delay: **${s.silenceDurationMs}ms**\n` +
      `  Noise threshold: **${s.speechThreshold}** (higher = ignores more noise)\n` +
      `  Min speech duration: **${s.minSpeechDurationMs}ms**`,
    );
  } else if (message.content.startsWith('~delay ')) {
    const val = parseInt(message.content.slice('~delay '.length).trim(), 10);
    if (isNaN(val) || val < 500 || val > 10000) {
      await message.reply('Usage: `~delay <500-10000>` (milliseconds). Example: `~delay 3000`');
      return;
    }
    setSilenceDuration(val);
    await message.reply(`Silence delay set to **${val}ms**. Takes effect on next utterance.`);
  } else if (message.content.startsWith('~noise ')) {
    const input = message.content.slice('~noise '.length).trim();
    const result = resolveNoiseLevel(input);
    if (!result) {
      const presets = getNoisePresetNames().join(', ');
      await message.reply(`Usage: \`~noise <${presets}>\` or \`~noise <number>\`. Example: \`~noise high\``);
      return;
    }
    setSpeechThreshold(result.threshold);
    await message.reply(`Noise threshold set to **${result.label}** (${result.threshold}). Higher = ignores more background noise.`);
  }
});

// --- Voice state update: auto-join/leave ---

client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
  const targetChannelId = config.discordVoiceChannelId;

  // User joined the target voice channel
  if (newState.channelId === targetChannelId && oldState.channelId !== targetChannelId) {
    if (!newState.member?.user.bot) {
      // Cancel any pending leave timeout
      if (leaveTimeout) {
        clearTimeout(leaveTimeout);
        leaveTimeout = null;
      }

      // Auto-join if not already connected
      if (!getConnection()) {
        console.log(`User ${newState.member?.user.username} joined, auto-joining voice channel`);
        handleJoin(newState.guild.id).catch((err) => {
          console.error('Auto-join failed:', err.message);
        });
      }
    }
  }

  // User left the target voice channel
  if (oldState.channelId === targetChannelId && newState.channelId !== targetChannelId) {
    if (!oldState.member?.user.bot) {
      // Check if any humans remain in the channel
      const channel = oldState.guild.channels.cache.get(targetChannelId);
      if (channel && channel.type === ChannelType.GuildVoice) {
        const humans = channel.members.filter((m) => !m.user.bot);
        if (humans.size === 0) {
          console.log('No humans left in voice channel, leaving in 30s...');
          leaveTimeout = setTimeout(() => {
            // Double check no one rejoined
            const ch = oldState.guild.channels.cache.get(targetChannelId);
            if (ch && ch.type === ChannelType.GuildVoice) {
              const stillHumans = ch.members.filter((m) => !m.user.bot);
              if (stillHumans.size === 0) {
                handleLeave();
              }
            }
            leaveTimeout = null;
          }, 30_000);
        }
      }
    }
  }
});

// --- Core join/leave logic ---

async function handleJoin(guildId: string, message?: any): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.error('Guild not found');
    return;
  }

  try {
    const connection = await joinChannel(
      config.discordVoiceChannelId,
      guildId,
      guild.voiceAdapterCreator,
    );

    // Set up reconnection handling
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Try to reconnect within 5s
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Seems to be reconnecting
      } catch {
        // Disconnected for real
        console.log('Voice connection lost, cleaning up');
        handleLeave();
      }
    });

    // Find log channel if configured
    let logChannel: TextChannel | undefined;
    if (config.logChannelId) {
      const ch = guild.channels.cache.get(config.logChannelId);
      if (ch && ch.type === ChannelType.GuildText) {
        logChannel = ch as TextChannel;
      }
    }

    // Stop existing pipeline
    if (pipeline) {
      pipeline.stop();
    }

    pipeline = new VoicePipeline(connection, logChannel);
    router = new ChannelRouter(guild);
    pipeline.setRouter(router);
    pipeline.start();

    if (message) {
      await message.reply('Joined voice channel. Listening...');
    }
  } catch (error: any) {
    console.error('Failed to join:', error.message);
    if (message) {
      await message.reply(`Failed to join: ${error.message}`);
    }
  }
}

function handleLeave(): void {
  if (pipeline) {
    pipeline.stop();
    pipeline = null;
  }
  router = null;
  leaveChannel();
}

// --- Auto-join on startup ---

// --- Slash command handler ---

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'watson') return;

  // Defer upfront — switchTo can trigger Discord message fetches that take time
  await interaction.deferReply();

  // Auto-join voice if not connected
  if (!router || !pipeline) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply('This command must be used in a server.');
      return;
    }
    await handleJoin(guildId);
    if (!router || !pipeline) {
      await interaction.editReply('Failed to join voice channel.');
      return;
    }
  }

  const channelId = interaction.channelId;
  const result = await router.switchTo(channelId);
  if (!result.success) {
    await interaction.editReply(result.error!);
    return;
  }

  await pipeline!.onChannelSwitch();
  const label = result.displayName || `<#${channelId}>`;

  // Try to move user into voice channel if they're not already there
  let voiceNote = '';
  const member = interaction.member as GuildMember | null;
  if (member?.voice) {
    if (member.voice.channelId !== config.discordVoiceChannelId) {
      if (member.voice.channelId) {
        try {
          await member.voice.setChannel(config.discordVoiceChannelId);
        } catch {
          voiceNote = `\nJoin voice: <#${config.discordVoiceChannelId}>`;
        }
      } else {
        voiceNote = `\nJoin voice: <#${config.discordVoiceChannelId}>`;
      }
    }
  }

  await interaction.editReply(`Switched ${config.botName} to **${label}**. Loaded ${result.historyCount} history messages.${voiceNote}`);
});

// --- Auto-join on startup ---

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  // Register slash command
  const command = new SlashCommandBuilder()
    .setName('watson')
    .setDescription(`Switch ${config.botName} voice to this channel`);

  const rest = new REST().setToken(config.discordToken);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, config.discordGuildId),
      { body: [command.toJSON()] },
    );
    console.log('Registered /watson slash command');
  } catch (err: any) {
    console.error('Failed to register slash command:', err.message);
  }

  // Auto-join the configured voice channel
  const guild = client.guilds.cache.get(config.discordGuildId);
  if (guild) {
    const channel = guild.channels.cache.get(config.discordVoiceChannelId);
    if (channel && channel.type === ChannelType.GuildVoice) {
      const humans = channel.members.filter((m) => !m.user.bot);
      if (humans.size > 0) {
        console.log('Users detected in voice channel, auto-joining...');
        await handleJoin(config.discordGuildId);
      } else {
        console.log('No users in voice channel, waiting for someone to join...');
      }
    }
  }
});

// --- Graceful shutdown ---

function shutdown(): void {
  console.log('Shutting down gracefully...');
  handleLeave();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---

client.login(config.discordToken).catch((err) => {
  console.error('Failed to login:', err.message);
  process.exit(1);
});
