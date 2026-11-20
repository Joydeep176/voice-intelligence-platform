import type { RecordingMetadata } from '@vip/contracts';
import { FolderOpen, Upload } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { RecordingsTable } from '@/components/recordings-table';
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
  const { notify } = useToast();

  const items = first.status === 'success' ? [...first.data.items, ...(extra?.items ?? [])] : [];
  const cursor = extra ? extra.cursor : first.status === 'success' ? first.data.nextCursor : null;

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
        description="Every recording in this workspace, newest first."
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
        <Card>
          <CardContent>
            <RecordingsTable items={items} caption="Recordings" />
            {cursor ? (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? <Spinner data-icon="inline-start" /> : null}
                  Load more
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
