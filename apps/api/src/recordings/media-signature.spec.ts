import { detectMediaFamily, signatureMatches } from './media-signature';

const wavHeader = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);

describe('media signature (shallow validation)', () => {
  it.each([
    [wavHeader, 'wav'],
    [Buffer.from('fLaC\0\0\0\0'), 'flac'],
    [Buffer.from('OggS\0\0\0\0'), 'ogg'],
    [Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ')]), 'mp4'],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]), 'webm'],
    [Buffer.from('ID3\x04\0'), 'mp3'],
    [Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'mp3'],
  ])('detects %#', (head, family) => {
    expect(detectMediaFamily(head)).toBe(family);
  });

  it('returns null for unknown or truncated content', () => {
    expect(detectMediaFamily(Buffer.from('hello world'))).toBeNull();
    expect(detectMediaFamily(Buffer.alloc(0))).toBeNull();
  });

  it('matches only when the declared MIME family agrees with the content', () => {
    expect(signatureMatches('audio/wav', wavHeader)).toBe(true);
    expect(signatureMatches('audio/x-wav', wavHeader)).toBe(true);
    expect(signatureMatches('audio/mpeg', wavHeader)).toBe(false);
    expect(signatureMatches('text/plain', wavHeader)).toBe(false);
  });
});
