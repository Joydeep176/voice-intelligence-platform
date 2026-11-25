import { decodeCursor, encodeCursor, runContext, toSttRawDto } from './transcript.mapper';

const ID = '11111111-1111-4111-8111-111111111111';

describe('cursor', () => {
  it('round-trips and is opaque', () => {
    const cursor = encodeCursor({ startMs: 12_345, id: ID });
    expect(cursor).not.toContain(ID);
    expect(decodeCursor(cursor)).toEqual({ startMs: 12_345, id: ID });
  });

  it.each([
    'garbage',
    '',
    Buffer.from('{"a":1}').toString('base64url'),
    Buffer.from(JSON.stringify([-1, ID])).toString('base64url'),
    Buffer.from(JSON.stringify([1.5, ID])).toString('base64url'),
    Buffer.from(JSON.stringify([1, "'; drop table x; --"])).toString('base64url'),
  ])('rejects %j', (value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});

describe('runContext', () => {
  it('reads window source and providers from the run config; null until the run started', () => {
    expect(runContext({ schemaVersion: 1, stages: ['transcription'] })).toEqual({
      windowSource: null,
      providers: null,
    });
    expect(runContext(null)).toEqual({ windowSource: null, providers: null });
    expect(
      runContext({
        schemaVersion: 1,
        stages: ['transcription'],
        window: { source: 'vad_segments', windowMs: null, overlapMs: null, count: 2 },
      }).windowSource,
    ).toBe('vad_segments');
  });
});

describe('raw output DTO', () => {
  it('exposes metadata only and marks the fake provider; never the storage URI', () => {
    const dto = toSttRawDto({
      id: ID,
      workspaceId: ID,
      runId: ID,
      windowIndex: 2,
      windowStartMs: 0,
      windowEndMs: 1000,
      provider: 'fake',
      providerModel: 'fake-stt-1',
      requestParams: null,
      payloadUri: 'local://runs/x/y/stt/2.json',
      sha256: 'a'.repeat(64),
      receivedAt: new Date('2026-11-22T10:00:00.000Z'),
    });
    expect(dto.fake).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('local://');
  });
});
