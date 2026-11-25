import type { Recording } from '@vip/db';

/** What `POST /recordings/{id}/processing` does for a recording in this status. */
export type RecordingGate =
  | { kind: 'reject'; detail: string }
  | { kind: 'validating' }
  | { kind: 'probe' }
  | { kind: 'preprocess' };

export function gateRecording(status: Recording['status']): RecordingGate {
  switch (status) {
    case 'uploaded':
      return { kind: 'probe' };
    case 'validating':
      return { kind: 'validating' };
    case 'valid':
      return { kind: 'preprocess' };
    case 'invalid':
      return { kind: 'reject', detail: 'The recording failed validation and cannot be processed.' };
    case 'uploading':
      return { kind: 'reject', detail: 'The upload of this recording is not complete.' };
    case 'deleting':
      return { kind: 'reject', detail: 'The recording is being deleted.' };
  }
}
