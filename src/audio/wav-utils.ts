/**
 * Generates a WAV file buffer from raw PCM data.
 * Assumes 16-bit signed integer, little-endian, mono, 48kHz.
 */

export function pcmToWav(pcm: Buffer, sampleRate: number = 48000, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);  // File size - 8
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // Chunk size
  header.writeUInt16LE(1, 20);             // PCM format
  header.writeUInt16LE(channels, 22);      // Channels
  header.writeUInt32LE(sampleRate, 24);    // Sample rate
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28); // Byte rate
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);              // Block align
  header.writeUInt16LE(bitsPerSample, 34); // Bits per sample

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
