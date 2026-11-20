import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RecordingMetadata } from '@vip/contracts';
import { Capabilities } from '@/components/dashboard/capabilities';
import { Hero } from '@/components/dashboard/hero';
import { KpiCards, type Loaded } from '@/components/dashboard/kpi-cards';
import { RecentRecordings } from '@/components/dashboard/recent-recordings';
import { SystemHealth } from '@/components/dashboard/system-health';
import { api } from '@/lib/api';

const PAGE = 100;
const MAX_PAGES = 5;

/** No count endpoint exists: load up to 500 recent recordings and say so when more remain. */
function useRecordings() {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const items: RecordingMetadata[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const res = await api.listRecordings({ limit: PAGE, cursor }, controller.signal);
          items.push(...res.items);
          cursor = res.nextCursor;
          if (cursor === null) break;
        }
        if (!controller.signal.aborted)
          setState({ status: 'success', items, partial: cursor !== null });
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'error', error });
      }
    })();
    return () => controller.abort();
  }, [nonce]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setNonce((n) => n + 1);
  }, []);
  return useMemo(() => ({ state, reload }), [state, reload]);
}

export default function DashboardPage() {
  const { state, reload } = useRecordings();
  return (
    <div className="grid gap-8">
      <Hero />
      <KpiCards data={state} />
      {state.status === 'success' && state.partial ? (
        <p className="text-muted-foreground -mt-4 text-xs">
          Counts cover the 500 most recent recordings.
        </p>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <RecentRecordings data={state} onRetry={reload} />
        <SystemHealth />
      </div>
      <Capabilities />
    </div>
  );
}
