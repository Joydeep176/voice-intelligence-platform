import { FileText } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * No transcript endpoint exists yet, so nothing is requested or shown. When it does, this card
 * fetches by time range (frontend rule) and never displays fabricated lines, speakers or scores.
 */
export function TranscriptCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Transcript</CardTitle>
        <CardDescription>
          Language identification, speaker labels and uncertainty come with transcription, in a
          later phase.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bg-muted/50 text-muted-foreground flex items-start gap-3 rounded-md border border-dashed p-4 text-sm">
          <FileText aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            No transcript is available yet. It will appear here once this recording has been
            processed.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
