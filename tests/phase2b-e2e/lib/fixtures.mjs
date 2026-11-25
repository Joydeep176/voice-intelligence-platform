// Synthetic fixtures only (ADR-0004): generated with FFmpeg lavfi inside the audio image.
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, IMAGE, docker } from './stack.mjs';

mkdirSync(FIXTURES, { recursive: true });
export const fx = (name) => join(FIXTURES, name);

function ffmpeg(out, inputArgs, outArgs = []) {
  if (existsSync(fx(out))) return fx(out);
  const r = docker(
    'run',
    '--rm',
    '--entrypoint',
    'ffmpeg',
    '-v',
    `${FIXTURES}:/out`,
    IMAGE,
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputArgs,
    ...outArgs,
    `/out/${out}`,
  );
  if (r.status !== 0) throw new Error(`fixture ${out}: ${r.stderr.slice(-300)}`);
  return fx(out);
}

/** Speech-like: pink noise, 4 Hz amplitude modulation, 3 s silence in every 10 s. */
const speechLike = (seconds, rate, seed) =>
  `anoisesrc=d=${seconds}:c=pink:r=${rate}:seed=${seed}:a=0.5,tremolo=f=4:d=0.8,volume='if(lt(mod(t,10),7),1,0)':eval=frame`;

export function makeFixtures() {
  const f = {};
  f.sine10 = ffmpeg(
    'sine10.wav',
    ['-f', 'lavfi', '-i', 'sine=f=440:d=10:r=16000'],
    ['-ac', '1', '-c:a', 'pcm_s16le'],
  );
  f.speech20mp3 = ffmpeg(
    'speech20.mp3',
    ['-f', 'lavfi', '-i', speechLike(20, 44100, 1)],
    ['-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k'],
  );
  for (const n of [1, 2, 3]) {
    f[`conc${n}`] = ffmpeg(
      `conc${n}.flac`,
      ['-f', 'lavfi', '-i', speechLike(120, 48000, 10 + n)],
      ['-ac', '2', '-c:a', 'flac'],
    );
  }
  f.long12 = ffmpeg(
    'long12.flac',
    ['-f', 'lavfi', '-i', speechLike(720, 48000, 99)],
    ['-ac', '2', '-c:a', 'flac'],
  );
  // Format matrix (short)
  f.ogg = ffmpeg(
    'chirp.ogg',
    ['-f', 'lavfi', '-i', 'sine=f=300:d=5:r=22050'],
    ['-c:a', 'libvorbis'],
  );
  f.m4a = ffmpeg('tone.m4a', ['-f', 'lavfi', '-i', 'sine=f=500:d=5:r=48000'], ['-c:a', 'aac']);
  // Corrupt: valid magic, garbage body; truncated; HLS playlist.
  if (!existsSync(fx('garbage.wav'))) {
    const head = Buffer.from('RIFF\xff\xff\xff\x7fWAVEfmt ', 'latin1');
    const body = Buffer.alloc(4000);
    for (let i = 0; i < body.length; i++) body[i] = (i * 7919 + 13) & 0xff;
    writeFileSync(fx('garbage.wav'), Buffer.concat([head, body]));
  }
  if (!existsSync(fx('truncated.flac'))) {
    const whole = readFileSync(f.long12.replace('long12', 'conc1'));
    writeFileSync(fx('truncated.flac'), whole.subarray(0, 1500));
  }
  if (!existsSync(fx('playlist.mp3'))) {
    writeFileSync(
      fx('playlist.mp3'),
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nhttp://127.0.0.1:9/seg0.ts\n#EXT-X-ENDLIST\n',
    );
  }
  f.garbage = fx('garbage.wav');
  f.truncated = fx('truncated.flac');
  f.playlist = fx('playlist.mp3');
  return f;
}
export const sizeOf = (p) => statSync(p).size;
