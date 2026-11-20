/**
 * Shallow container check on the first bytes of an upload (LLD §2.1 "shallow validation").
 * It only confirms that the declared MIME type matches the file's signature. Deep validation
 * (codec, duration, integrity) is the audio service's `probe` task in a later phase (FR-1.3).
 */
export type MediaFamily = 'wav' | 'mp3' | 'flac' | 'ogg' | 'mp4' | 'webm';

export const SIGNATURE_BYTES = 16;

const FAMILY_BY_MIME: Record<string, MediaFamily> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'mp4',
};

export function detectMediaFamily(head: Buffer): MediaFamily | null {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString('latin1');
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (head.length >= 4 && ascii(0, 4) === 'fLaC') return 'flac';
  if (head.length >= 4 && ascii(0, 4) === 'OggS') return 'ogg';
  if (head.length >= 8 && ascii(4, 8) === 'ftyp') return 'mp4';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (head.length >= 3 && ascii(0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return 'mp3';
  return null;
}

export function signatureMatches(mimeType: string, head: Buffer): boolean {
  const expected = FAMILY_BY_MIME[mimeType];
  return expected !== undefined && detectMediaFamily(head) === expected;
}
