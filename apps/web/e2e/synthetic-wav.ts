/** Synthetic sine-tone WAV generated at test time. No real recordings are used (ADR-0004). */
export function syntheticWav(durationMs: number, sampleRate = 16_000, frequencyHz = 440): Buffer {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVEfmt ', 8, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * 0.3 * 32767),
      44 + i * 2,
    );
  }
  return buf;
}
