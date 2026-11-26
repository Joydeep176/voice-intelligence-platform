import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AGENT_ARCHITECTURE §2.2 / ADR-0046 / FR-3.3: A1 never reads transcription data, and its write
 * surface is A1's own tables only. Static check over the A1 module and its database repository.
 */
const FORBIDDEN = [
  'transcripts',
  'transcriptVersions',
  'transcriptSegments',
  'transcriptionUncertainties',
  'sttRawOutputs',
  'diarizationRawOutputs',
  'speakers',
  'getTranscript',
  'completeRunWithTranscript',
  'insertSttRawOutput',
  'insertDiarizationRawOutput',
  'listSttRawOutputs',
  'tokenProbability',
  'confidence\\s*:\\s*seg', // never derived from transcription confidence
];

function sources(dir: string): [string, string][] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')]);
}

describe('A1 separation from transcription (static)', () => {
  const a1 = sources(__dirname);
  const repo: [string, string] = [
    'packages/db/src/audio-quality.ts',
    readFileSync(join(__dirname, '../../../../../packages/db/src/audio-quality.ts'), 'utf8'),
  ];

  it.each([...a1, repo])('%s references no transcription table or helper', (_name, text) => {
    for (const word of FORBIDDEN) expect(text).not.toMatch(new RegExp(`\\b${word}\\b`));
  });

  it('the A1 repository writes only A1 tables and measurement sets', () => {
    const inserts = [...repo[1].matchAll(/\.insert\((\w+)\)/g)].map((m) => m[1]);
    expect(new Set(inserts)).toEqual(
      new Set([
        'audioMeasurementSets',
        'audioMeasurements',
        'audioDiagnostics',
        'audioDiagnosticFlags',
      ]),
    );
    const updates = [...repo[1].matchAll(/\.update\((\w+)\)/g)].map((m) => m[1]);
    expect(new Set(updates)).toEqual(new Set(['audioMeasurementSets']));
  });

  it('the A1 node writes diagnostics through the repository only', () => {
    const node = a1.find(([f]) => f === 'node.ts')![1];
    expect(node).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });
});
