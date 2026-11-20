import type { AudioMimeType } from '@vip/contracts';

/** Audio container families, mirroring the server's signature rule (media-signature.ts). */
export type Family = 'wav' | 'mp3' | 'mp4' | 'flac' | 'ogg' | 'webm';

export const FAMILY_LABEL: Record<Family, string> = {
  wav: 'WAV',
  mp3: 'MP3',
  mp4: 'M4A',
  flac: 'FLAC',
  ogg: 'OGG',
  webm: 'WebM',
};

export const FORMAT_CHIPS = Object.values(FAMILY_LABEL);

export function familyOf(mime: AudioMimeType): Family {
  if (mime.includes('wav') || mime.includes('wave')) return 'wav';
  if (mime === 'audio/mpeg') return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

const ascii = (b: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** Recognises a family from the first 16 bytes, or null when the content is not recognised. */
export function detectFamily(b: Uint8Array): Family | null {
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return 'wav';
  if (ascii(b, 0, 'fLaC')) return 'flac';
  if (ascii(b, 0, 'OggS')) return 'ogg';
  if (ascii(b, 4, 'ftyp')) return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (ascii(b, 0, 'ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

/** Reads only the first 16 bytes locally. Makes no network request; never throws. */
export function sniffFile(file: Blob): Promise<Family | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(detectFamily(new Uint8Array(reader.result as ArrayBuffer)));
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, 16));
  });
}
