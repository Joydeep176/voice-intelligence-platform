import type {
  RunProviderRef,
  SpeakerDto,
  TranscriptSegmentDto,
  TranscriptVersionDto,
  UncertaintyDto,
  WindowSource,
} from '@vip/contracts';
import { useCallback, useEffect, useState } from 'react';
import { transcriptionApi } from './api';
import { renameErrorMessage } from './model';

export const PAGE_SIZE = 100;
/** Uncertainty spans are fetched for the loaded range only, following cursors a bounded number of times. */
const UNCERTAINTY_PAGES = 5;

export interface LoadedPage {
  version: number;
  items: TranscriptSegmentDto[];
  nextCursor: string | null;
  windowSource: WindowSource | null;
  providers: { stt: RunProviderRef; diarization: RunProviderRef } | null;
}

export type PageState =
  { status: 'loading' } | { status: 'error'; error: unknown } | ({ status: 'ready' } & LoadedPage);

export type SpeakersState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: SpeakerDto[] };

async function uncertaintiesFor(
  runId: string,
  version: number,
  items: TranscriptSegmentDto[],
  signal?: AbortSignal,
): Promise<UncertaintyDto[]> {
  if (items.length === 0) return [];
  const fromMs = Math.min(...items.map((s) => s.startMs));
  const toMs = Math.max(...items.map((s) => s.endMs)) + 1;
  const out: UncertaintyDto[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < UNCERTAINTY_PAGES; i += 1) {
    const page = await transcriptionApi.uncertainties(
      runId,
      { version, fromMs, toMs, limit: 1000, cursor },
      signal,
    );
    out.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

const mergeById = <T extends { id: string }>(prev: T[], next: T[]) => {
  const seen = new Set(prev.map((p) => p.id));
  return [...prev, ...next.filter((n) => !seen.has(n.id))];
};

/**
 * Transcript view state for one run (mount with `key={runId}`): keyset-paged segments, optional
 * version, uncertainty spans for the loaded range, speakers and rename. Never loads the whole
 * transcript at once. Transcript text is never logged.
 */
export function useTranscript(runId: string) {
  const [versions, setVersions] = useState<TranscriptVersionDto[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [page, setPage] = useState<PageState>({ status: 'loading' });
  const [uncertainties, setUncertainties] = useState<UncertaintyDto[]>([]);
  const [uncertaintyFailed, setUncertaintyFailed] = useState(false);
  const [speakers, setSpeakers] = useState<SpeakersState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    transcriptionApi.versions(runId, controller.signal).then(
      (v) => !controller.signal.aborted && setVersions(v.items),
      () => undefined, // The selector is optional: without the list the latest version is shown.
    );
    return () => controller.abort();
  }, [runId, nonce]);

  useEffect(() => {
    const controller = new AbortController();
    transcriptionApi.speakers(runId, controller.signal).then(
      (s) => !controller.signal.aborted && setSpeakers({ status: 'ready', items: s.items }),
      () => !controller.signal.aborted && setSpeakers({ status: 'error' }),
    );
    return () => controller.abort();
  }, [runId, nonce]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const p = await transcriptionApi.transcript(runId, { version, limit: PAGE_SIZE }, signal);
        if (signal.aborted) return;
        setPage({
          status: 'ready',
          version: p.version,
          items: p.items,
          nextCursor: p.nextCursor,
          windowSource: p.windowSource,
          providers: p.providers,
        });
        setUncertainties([]);
        setUncertaintyFailed(false);
        try {
          const u = await uncertaintiesFor(runId, p.version, p.items, signal);
          if (!signal.aborted) setUncertainties(u);
        } catch {
          if (!signal.aborted) setUncertaintyFailed(true);
        }
      } catch (error) {
        if (!signal.aborted) setPage({ status: 'error', error });
      }
    })();
    return () => controller.abort();
  }, [runId, version, nonce]);

  const loadMore = useCallback(async () => {
    if (page.status !== 'ready' || !page.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const next = await transcriptionApi.transcript(runId, {
        version: page.version,
        limit: PAGE_SIZE,
        cursor: page.nextCursor,
      });
      setPage({ ...page, items: mergeById(page.items, next.items), nextCursor: next.nextCursor });
      try {
        const u = await uncertaintiesFor(runId, page.version, next.items);
        setUncertainties((prev) => mergeById(prev, u));
      } catch {
        setUncertaintyFailed(true);
      }
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [page, runId, loadingMore]);

  const selectVersion = useCallback((v: number) => {
    setPage({ status: 'loading' });
    setVersion(v);
  }, []);

  const reload = useCallback(() => {
    setPage({ status: 'loading' });
    setSpeakers({ status: 'loading' });
    setNonce((n) => n + 1);
  }, []);

  /** Updates the list only after the server accepted the new name. */
  const rename = useCallback(
    async (speakerId: string, displayName: string): Promise<{ error: string | null }> => {
      try {
        const updated = await transcriptionApi.renameSpeaker(runId, speakerId, displayName);
        setSpeakers((s) =>
          s.status === 'ready'
            ? { status: 'ready', items: s.items.map((x) => (x.id === updated.id ? updated : x)) }
            : s,
        );
        return { error: null };
      } catch (error) {
        return { error: renameErrorMessage(error) };
      }
    },
    [runId],
  );

  return {
    versions,
    page,
    uncertainties,
    uncertaintyFailed,
    speakers,
    loadingMore,
    moreFailed,
    loadMore,
    selectVersion,
    reload,
    rename,
  };
}
