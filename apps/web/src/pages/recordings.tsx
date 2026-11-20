import type { RecordingMetadata } from '@vip/contracts';
import { FolderOpen, SearchX, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { RecordingsTable } from '@/components/recordings-table';
import {
  FILTERS,
  filterCounts,
  visibleRecordings,
  type SortKey,
  type StatusFilter,
} from '@/components/recordings/model';
import { RecordingsToolbar } from '@/components/recordings/toolbar';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/states';
import { useToast } from '@/components/toaster';
import { api, describeError } from '@/lib/api';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';

const PAGE = 25;

export default function RecordingsPage() {
  const first = useAsync((signal) => api.listRecordings({ limit: PAGE }, signal), []);
  const [extra, setExtra] = useState<{ items: RecordingMetadata[]; cursor: string | null } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('newest');
  const { notify } = useToast();

  const firstItems = first.status === 'success' ? first.data.items : null;
  const extraItems = extra?.items;
  const items = useMemo(
    () => (firstItems ? [...firstItems, ...(extraItems ?? [])] : []),
    [firstItems, extraItems],
  );
  const cursor = extra ? extra.cursor : first.status === 'success' ? first.data.nextCursor : null;

  const counts = useMemo(() => filterCounts(items), [items]);
  const shown = useMemo(
    () => visibleRecordings(items, query, filter, sort),
    [items, query, filter, sort],
  );
  const filtered = query.trim() !== '' || filter !== 'all';
  const clearFilters = () => {
    setQuery('');
    setFilter('all');
  };

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
        title="Recordings"
        description="Every recording in this workspace, with its upload and processing status."
        actions={
          <Button asChild>
            <Link to="/recordings/new">
              <Upload aria-hidden data-icon="inline-start" />
              Upload
            </Link>
          </Button>
        }
      />
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
          description="Uploaded recordings appear here with their validation and processing status."
          action={
            <Button asChild size="sm">
              <Link to="/recordings/new">Upload your first recording</Link>
            </Button>
          }
        />
      ) : null}
      {items.length > 0 ? (
        <div className="grid gap-3">
          <RecordingsToolbar
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            counts={counts}
            sort={sort}
            onSort={setSort}
          />
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
            <p aria-live="polite" className="tabular-nums">
              {filtered
                ? `Showing ${shown.length} of ${items.length} loaded`
                : `${items.length} ${items.length === 1 ? 'recording' : 'recordings'} loaded`}
              {cursor ? ' · more available' : ''}
            </p>
            {filtered && cursor ? (
              <p>Filters apply to loaded recordings. Load more to include older ones.</p>
            ) : null}
          </div>
          {shown.length === 0 ? (
            <EmptyState
              icon={<SearchX aria-hidden />}
              title="No recordings match"
              description={`Nothing loaded matches ${
                query.trim() ? `“${query.trim()}”` : 'your search'
              }${
                filter !== 'all'
                  ? ` with status ${FILTERS.find((f) => f.key === filter)?.label}`
                  : ''
              }.`}
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <Card className="py-0">
              <CardContent className="px-0">
                <RecordingsTable items={shown} caption="Recordings" />
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
