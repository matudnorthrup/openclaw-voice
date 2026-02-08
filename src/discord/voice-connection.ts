import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';

let currentConnection: VoiceConnection | null = null;

/**
 * Monkey-patch the DAVE session to keep passthrough mode permanently enabled.
 * This fixes "DecryptionFailed(UnencryptedWhenPassthroughDisabled)" errors
 * when users' Discord clients send unencrypted audio.
 */
function enableDavePassthrough(connection: VoiceConnection): void {
  const patchState = (state: any) => {
    const dave = state?.networking?.state?.dave;
    if (dave?.session) {
      try {
        // Set passthrough with a very long expiry (24 hours in seconds)
        dave.session.setPassthroughMode(true, 86400);
        console.log('[DAVE] Passthrough mode enabled');
      } catch (e: any) {
        console.log('[DAVE] Could not set passthrough:', e.message);
      }
    }
  };

  // Patch on state changes (DAVE session gets recreated on transitions)
  connection.on('stateChange', (_old: any, newState: any) => {
    patchState(newState);
  });

  // Patch current state
  patchState(connection.state);
}

export async function joinChannel(
  channelId: string,
  guildId: string,
  adapterCreator: any,
): Promise<VoiceConnection> {
  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: false,  // Critical: must be false to receive audio
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log('Voice connection ready');
    enableDavePassthrough(connection);
    currentConnection = connection;
    return connection;
  } catch (error) {
    connection.destroy();
    throw new Error(`Failed to join voice channel within 30s: ${error}`);
  }
}

export function leaveChannel(): void {
  if (currentConnection) {
    currentConnection.destroy();
    currentConnection = null;
    console.log('Left voice channel');
  }
}

export function getConnection(): VoiceConnection | null {
  return currentConnection;
}

export function setConnection(conn: VoiceConnection | null): void {
  currentConnection = conn;
}
