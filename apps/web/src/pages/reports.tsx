import type { RecordingMetadata } from '@vip/contracts';
import { FolderOpen, Info, SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { visibleReports, type ReportSortKey } from '@/components/reports/model';
import { ReportsList } from '@/components/reports/reports-list';
import { ReportsToolbar } from '@/components/reports/toolbar';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/states';
import { useToast } from '@/components/toaster';
import { api, describeError } from '@/lib/api';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';

const PAGE = 25;

export default function ReportsPage() {
  const first = useAsync((signal) => api.listRecordings({ limit: PAGE }, signal), []);
  const [extra, setExtra] = useState<{ items: RecordingMetadata[]; cursor: string | null } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ReportSortKey>('newest');
  const { notify } = useToast();

  const firstItems = first.status === 'success' ? first.data.items : null;
  const extraItems = extra?.items;
  const items = useMemo(
    () => (firstItems ? [...firstItems, ...(extraItems ?? [])] : []),
    [firstItems, extraItems],
  );
  const cursor = extra ? extra.cursor : first.status === 'success' ? first.data.nextCursor : null;
  const shown = useMemo(() => visibleReports(items, query, sort), [items, query, sort]);
  const filtered = query.trim() !== '';

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await api.listRecordings({ limit: PAGE, cursor });
      setExtra((prev) => ({
        items: [...(prev?.items ?? []), ...page.items],
        cursor: page.nextCursor,
      }));
    } catch (error) {
      notify({
        tone: 'error',
        title: 'Could not load more recordings',
        description: describeError(error),
      });
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Reports"
        description="Evidence-backed reports for each recording, produced by the analysis pipeline."
      />
      <Alert role="status">
        <Info aria-hidden />
        <AlertTitle>No reports have been generated yet</AlertTitle>
        <AlertDescription>
          The Reporting (A6) and QA (A7) agents are not connected, so no recording has a report.{' '}
          <Link to="/pipeline" className="text-foreground underline underline-offset-4">
            See pipeline status
          </Link>
          .
        </AlertDescription>
      </Alert>
      {first.status === 'loading' ? (
        <Card>
          <CardContent>
            <LoadingRows rows={6} label="Loading recordings" />
          </CardContent>
        </Card>
      ) : null}
      {first.status === 'error' ? (
        <ErrorState
          error={first.error}
          onRetry={() => {
            setExtra(null);
            first.reload();
          }}
        />
      ) : null}
      {first.status === 'success' && items.length === 0 ? (
        <EmptyState
          icon={<FolderOpen aria-hidden />}
          title="No recordings yet"
          description="Reports are listed per recording. Upload a recording to see it here."
          action={
            <Button asChild size="sm">
              <Link to="/recordings/new">Upload your first recording</Link>
            </Button>
          }
        />
      ) : null}
      {items.length > 0 ? (
        <div className="grid gap-3">
          <ReportsToolbar query={query} onQuery={setQuery} sort={sort} onSort={setSort} />
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
            <p aria-live="polite" className="tabular-nums">
              Showing {shown.length} of {items.length} loaded{' '}
              {items.length === 1 ? 'recording' : 'recordings'}
              {cursor ? ' · more available' : ''}
            </p>
            {filtered && cursor ? (
              <p>Search applies to loaded recordings. Load more to include older ones.</p>
            ) : null}
          </div>
          {shown.length === 0 ? (
            <EmptyState
              icon={<SearchX aria-hidden />}
              title="No recordings match"
              description={`Nothing loaded matches “${query.trim()}”.`}
              action={
                <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <Card className="py-0">
              <CardContent className="px-0">
                <ReportsList items={shown} />
              </CardContent>
            </Card>
          )}
          {cursor ? (
            <div className="flex items-center justify-center gap-3">
              <span className="text-muted-foreground text-xs tabular-nums">
                {items.length} loaded
              </span>
              <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? <Spinner data-icon="inline-start" /> : null}
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
