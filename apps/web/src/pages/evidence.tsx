import { Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { evidenceAvailability } from '@/components/evidence/model';
import {
  EvidenceFlow,
  EvidenceSlots,
  ProvenanceLinks,
  SourceTypes,
  WhatIsNeeded,
} from '@/components/evidence/evidence-panels';
import {
  RECORDING_PAGE_CLASS,
  RecordingBreadcrumb,
  recordingStateFallback,
} from '@/components/recording-frame';
import { PageHeader } from '@/components/states';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';

export default function EvidencePage({ id }: { id: string }) {
  const state = useAsync((signal) => api.getRecording(id, signal), [id]);

  const fallback = recordingStateFallback(state, {
    loadingLabel: 'Loading evidence',
    backTo: '/reports',
    backLabel: 'Back to reports',
  });
  if (fallback) return fallback;
  if (state.status !== 'success') return null;

  const r = state.data;
  const a = evidenceAvailability(r);
  return (
    <div className={RECORDING_PAGE_CLASS}>
      <RecordingBreadcrumb
        items={[
          { label: 'Reports', to: '/reports' },
          { label: r.originalFilename, to: `/recordings/${r.id}`, filename: true },
          { label: 'Evidence' },
        ]}
      />
      <PageHeader
        title="Evidence"
        description={r.originalFilename}
        actions={
          <>
            <Badge variant="outline">{a.label}</Badge>
            <Button asChild variant="outline" size="sm">
              <Link to={`/recordings/${r.id}/report`}>View report</Link>
            </Button>
          </>
        }
      />
      <Alert role="status">
        <Info aria-hidden />
        <AlertTitle>No evidence is available for this recording</AlertTitle>
        <AlertDescription>
          {a.reason}.{' '}
          <Link to="/pipeline" className="text-foreground underline underline-offset-4">
            See pipeline status
          </Link>
          .
        </AlertDescription>
      </Alert>

      <EvidenceFlow />
      <ProvenanceLinks />
      <SourceTypes />
      <EvidenceSlots />
      <WhatIsNeeded />
    </div>
  );
}
