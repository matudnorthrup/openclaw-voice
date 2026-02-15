import { config } from './config.js';
import { createClient } from './discord/client.js';
import { joinChannel, leaveChannel, getConnection, setConnection } from './discord/voice-connection.js';
import { VoicePipeline } from './pipeline/voice-pipeline.js';
import { clearConversation } from './services/claude.js';
import { ChannelRouter } from './services/channel-router.js';
import { GatewaySync } from './services/gateway-sync.js';
import { initVoiceSettings, getVoiceSettings, setSilenceDuration, setSpeechThreshold, setMinSpeechDuration, resolveNoiseLevel, getNoisePresetNames } from './services/voice-settings.js';
import { QueueState, type VoiceMode } from './services/queue-state.js';
import { ResponsePoller } from './services/response-poller.js';
import { InboxTracker } from './services/inbox-tracker.js';
import { VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { ChannelType, TextChannel, VoiceState, SlashCommandBuilder, REST, Routes, ChatInputCommandInteraction, GuildMember, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuInteraction, ButtonInteraction } from 'discord.js';

console.log(`${config.botName} Voice starting...`);

initVoiceSettings({
  silenceDurationMs: config.silenceDurationMs,
  speechThreshold: config.speechThreshold,
  minSpeechDurationMs: config.minSpeechDurationMs,
});

const client = createClient();
let pipeline: VoicePipeline | null = null;
let router: ChannelRouter | null = null;
let gatewaySync: GatewaySync | null = null;
let leaveTimeout: ReturnType<typeof setTimeout> | null = null;
let queueState: QueueState | null = null;
let responsePoller: ResponsePoller | null = null;

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
    const rawMode = queueState?.getMode() ?? 'wait';
    const modeLabel = rawMode === 'queue' ? 'inbox' : rawMode;
    await message.reply(
      `**Voice settings:**\n` +
      `  Voice mode: **${modeLabel}**\n` +
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
  } else if (message.content.startsWith('~mode ')) {
    let mode = message.content.slice('~mode '.length).trim().toLowerCase();
    if (mode === 'inbox') mode = 'queue';
    if (!['wait', 'queue', 'ask'].includes(mode)) {
      await message.reply('Usage: `~mode <wait|inbox|ask>`');
      return;
    }
    if (!queueState) {
      queueState = new QueueState();
    }
    queueState.setMode(mode as VoiceMode);
    await message.reply(`Voice mode set to **${mode}**.`);
  } else if (message.content === '~queue') {
    if (!queueState) {
      await message.reply('Queue state not initialized. Join voice first or use `~mode queue`.');
      return;
    }
    const ready = queueState.getReadyItems();
    const pending = queueState.getPendingItems();
    const mode = queueState.getMode();
    const lines = [`**Voice mode:** ${mode}`, `**Ready:** ${ready.length}`, `**Pending:** ${pending.length}`];
    if (ready.length > 0) {
      for (const item of ready) {
        lines.push(`  - ${item.displayName}: "${item.summary}"`);
      }
    }
    await message.reply(lines.join('\n'));
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
    router = new ChannelRouter(guild, gatewaySync ?? undefined);
    pipeline.setRouter(router);
    if (gatewaySync) {
      pipeline.setGatewaySync(gatewaySync);
    }

    // Wire queue state + poller
    if (!queueState) {
      queueState = new QueueState();
    }
    pipeline.setQueueState(queueState);
    if (gatewaySync) {
      responsePoller = new ResponsePoller(queueState, gatewaySync);
      responsePoller.setOnReady((displayName) => {
        pipeline?.notifyIfIdle(`Response ready from ${displayName}.`);
      });
      pipeline.setResponsePoller(responsePoller);
      responsePoller.start(); // starts only if pending items exist from previous session

      // Wire inbox tracker
      const inboxTracker = new InboxTracker(queueState, gatewaySync);
      pipeline.setInboxTracker(inboxTracker);

      // Ensure inbox snapshots exist across all modes so text-originated updates
      // remain discoverable via inbox-check even in wait mode.
      const channels = router.getAllChannelSessionKeys();
      const existingSnapshots = queueState.getSnapshots();
      if (Object.keys(existingSnapshots).length === 0) {
        void (async () => {
          try {
            const startedAt = Date.now();
            while (!gatewaySync.isConnected() && Date.now() - startedAt < 8000) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            if (!gatewaySync.isConnected()) {
              console.warn('InboxTracker: startup snapshot skipped (gateway not connected yet)');
              return;
            }
            const snapshots: Record<string, number> = {};
            for (const ch of channels) {
              const result = await gatewaySync.getHistory(ch.sessionKey, 40);
              snapshots[ch.sessionKey] = result?.messages?.length ?? 0;
            }
            queueState.setSnapshots(snapshots);
            console.log(`InboxTracker: startup snapshot — ${Object.entries(snapshots).map(([k, v]) => `${k.split(':').pop()}=${v}`).join(', ')}`);
          } catch (err: any) {
            console.warn(`InboxTracker startup snapshot failed: ${err.message}`);
          }
        })();
      }
    }

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
  if (responsePoller) {
    responsePoller.stop();
    responsePoller = null;
  }
  if (pipeline) {
    pipeline.stop();
    pipeline = null;
  }
  router = null;
  leaveChannel();
}

// --- Settings panel builder ---

function buildSettingsPanel(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  const s = getVoiceSettings();

  // Determine noise preset label
  const presetMap: Record<number, string> = { 300: 'Low', 500: 'Medium', 800: 'High' };
  const noiseLabel = presetMap[s.speechThreshold] ?? 'Custom';

  const embed = new EmbedBuilder()
    .setTitle('Voice Settings')
    .addFields(
      { name: `Noise Threshold — ${s.speechThreshold} (${noiseLabel})`, value: 'How loud audio must be to count as speech. Raise if the bot is picking up background noise.', inline: false },
      { name: `Silence Delay — ${s.silenceDurationMs}ms`, value: 'How long to wait after you stop talking before processing. Increase if the bot cuts you off mid-sentence.', inline: false },
      { name: `Min Speech Duration — ${s.minSpeechDurationMs}ms`, value: 'Shortest utterance the bot will accept. Raise to ignore brief noises like coughs or "um".', inline: false },
    );

  const noiseRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('noise-select')
      .setPlaceholder('Noise threshold')
      .addOptions(
        { label: 'Low (300)', description: 'Quiet room, picks up soft speech', value: '300', default: s.speechThreshold === 300 },
        { label: 'Medium (500)', description: 'Some background noise', value: '500', default: s.speechThreshold === 500 },
        { label: 'High (800)', description: 'Noisy environment, ignores more', value: '800', default: s.speechThreshold === 800 },
      ),
  );

  const delayRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('label-delay').setLabel('Silence Delay').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('delay-minus').setLabel('-500ms').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('delay-1000').setLabel('1000').setStyle(s.silenceDurationMs === 1000 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('delay-1500').setLabel('1500').setStyle(s.silenceDurationMs === 1500 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('delay-plus').setLabel('+500ms').setStyle(ButtonStyle.Secondary),
  );

  const minSpeechRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('label-minspeech').setLabel('Min Speech').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('minspeech-minus').setLabel('-100ms').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('minspeech-200').setLabel('200').setStyle(s.minSpeechDurationMs === 200 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('minspeech-300').setLabel('300').setStyle(s.minSpeechDurationMs === 300 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('minspeech-plus').setLabel('+100ms').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [noiseRow, delayRow, minSpeechRow] };
}

// --- Slash command handler ---

client.on('interactionCreate', async (interaction) => {
  // --- Component interactions (buttons / select menus) ---
  if (interaction.isStringSelectMenu() && interaction.customId === 'noise-select') {
    const value = parseInt(interaction.values[0], 10);
    setSpeechThreshold(value);
    await interaction.update(buildSettingsPanel());
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('delay-')) {
    const s = getVoiceSettings();
    let newDelay: number;

    if (interaction.customId === 'delay-minus') {
      newDelay = Math.max(500, s.silenceDurationMs - 500);
    } else if (interaction.customId === 'delay-plus') {
      newDelay = Math.min(10000, s.silenceDurationMs + 500);
    } else {
      newDelay = parseInt(interaction.customId.slice('delay-'.length), 10);
    }

    setSilenceDuration(newDelay);
    await interaction.update(buildSettingsPanel());
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('minspeech-')) {
    const s = getVoiceSettings();
    let newVal: number;

    if (interaction.customId === 'minspeech-minus') {
      newVal = Math.max(100, s.minSpeechDurationMs - 100);
    } else if (interaction.customId === 'minspeech-plus') {
      newVal = Math.min(2000, s.minSpeechDurationMs + 100);
    } else {
      newVal = parseInt(interaction.customId.slice('minspeech-'.length), 10);
    }

    setMinSpeechDuration(newVal);
    await interaction.update(buildSettingsPanel());
    return;
  }

  // --- Slash commands ---
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'watson-settings') {
    await interaction.reply({ ...buildSettingsPanel(), ephemeral: true });
    return;
  }

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

  // Connect to OpenClaw gateway for session sync
  if (config.gatewayWsEnabled) {
    gatewaySync = new GatewaySync();
    gatewaySync.connect().catch((err) => {
      console.warn(`OpenClaw gateway sync unavailable: ${err.message}`);
    });
  }

  // Register slash commands
  const watsonCommand = new SlashCommandBuilder()
    .setName('watson')
    .setDescription(`Switch ${config.botName} voice to this channel`);

  const settingsCommand = new SlashCommandBuilder()
    .setName('watson-settings')
    .setDescription('View and adjust voice settings');

  const rest = new REST().setToken(config.discordToken);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, config.discordGuildId),
      { body: [watsonCommand.toJSON(), settingsCommand.toJSON()] },
    );
    console.log('Registered /watson and /watson-settings slash commands');
  } catch (err: any) {
    console.error('Failed to register slash commands:', err.message);
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
  if (responsePoller) {
    responsePoller.stop();
    responsePoller = null;
  }
  if (gatewaySync) {
    gatewaySync.destroy();
    gatewaySync = null;
  }
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
