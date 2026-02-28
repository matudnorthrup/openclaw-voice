import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';

let currentConnection: VoiceConnection | null = null;
const VOICE_JOIN_TIMEOUT_MS = 30_000;
const VOICE_JOIN_MAX_ATTEMPTS = 3;
const VOICE_JOIN_RETRY_BASE_MS = 1_500;

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
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= VOICE_JOIN_MAX_ATTEMPTS; attempt++) {
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,  // Critical: must be false to receive audio
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_JOIN_TIMEOUT_MS);
      console.log('Voice connection ready');
      enableDavePassthrough(connection);
      currentConnection = connection;
      return connection;
    } catch (error) {
      lastError = error;
      connection.destroy();

      const message = String((error as Error)?.message ?? error ?? 'unknown error');
      const transient =
        message.includes('Cannot perform IP discovery') ||
        message.includes('socket closed');
      const hasRetry = attempt < VOICE_JOIN_MAX_ATTEMPTS;

      if (transient && hasRetry) {
        const delay = VOICE_JOIN_RETRY_BASE_MS * attempt;
        console.warn(`Voice join failed (attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS}): ${message}. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      break;
    }
  }

  throw new Error(`Failed to join voice channel within ${Math.floor(VOICE_JOIN_TIMEOUT_MS / 1000)}s: ${lastError}`);
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
