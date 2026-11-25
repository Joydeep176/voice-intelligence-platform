import { gateRecording } from './start-decision';

describe('gateRecording', () => {
  it('probes an uploaded recording, waits on a validating one, preprocesses a valid one', () => {
    expect(gateRecording('uploaded')).toEqual({ kind: 'probe' });
    expect(gateRecording('validating')).toEqual({ kind: 'validating' });
    expect(gateRecording('valid')).toEqual({ kind: 'preprocess' });
  });

  it.each(['invalid', 'uploading', 'deleting'] as const)('rejects a %s recording', (status) => {
    expect(gateRecording(status).kind).toBe('reject');
  });
});
