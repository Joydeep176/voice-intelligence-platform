import { Check, Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const NOW = [
  'Consented upload of synthetic or consented recordings',
  'Resumable chunked upload',
  'Audio format signature validation',
  'Storage scoped per workspace',
  'Run record per upload with status tracking',
  'Live service health',
];

const LATER = [
  'Transcription with language ID (English / Hindi / Hinglish) and diarization',
  'Audio quality diagnostics',
  'Context analysis',
  'Research and fact validation',
  'Evidence-backed reports',
];

export function Capabilities() {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg">What the platform does today</h2>
        </CardTitle>
        <CardDescription>
          Nothing here is processed or analysed yet; uploads are stored and tracked.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="cap-now" className="grid content-start gap-3">
          <h3 id="cap-now" className="text-sm font-semibold">
            Available now
          </h3>
          <ul className="grid gap-2.5">
            {NOW.map((t) => (
              <li key={t} className="flex gap-2.5 text-sm">
                <Check aria-hidden className="text-success mt-0.5 size-4 shrink-0" />
                {t}
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="cap-later" className="grid content-start gap-3">
          <h3 id="cap-later" className="text-muted-foreground text-sm font-semibold">
            Arrives in later phases
            <span className="bg-muted ml-2 rounded-full px-2 py-0.5 text-xs font-medium">
              Not available yet
            </span>
          </h3>
          <ul className="text-muted-foreground grid gap-2.5">
            {LATER.map((t) => (
              <li key={t} className="flex gap-2.5 text-sm">
                <Clock aria-hidden className="mt-0.5 size-4 shrink-0" />
                {t}
              </li>
            ))}
          </ul>
        </section>
      </CardContent>
    </Card>
  );
}
