import { Fragment, type ReactNode } from 'react';
import { ChevronRight, FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/states';
import { ApiRequestError } from '@/lib/api';
import { Link } from '@/lib/router';
import type { AsyncState } from '@/lib/use-async';

/** Page root for recording-scoped pages: lets long unbroken filenames wrap instead of overflowing. */
export const RECORDING_PAGE_CLASS = 'grid grid-cols-[minmax(0,1fr)] gap-6 [overflow-wrap:anywhere]';

const linkClass = 'hover:text-foreground underline-offset-4 hover:underline';

export type Crumb = {
  label: string;
  /** Omit for plain text. */
  to?: string;
  /** Marks the recording filename: truncates with an ellipsis and keeps the full name in `title`. */
  filename?: boolean;
};

/** Breadcrumb trail. The last item is the current page. */
export function RecordingBreadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          const title = item.filename ? item.label : undefined;
          return (
            <Fragment key={`${i}-${item.label}`}>
              {i > 0 && (
                <li aria-hidden>
                  <ChevronRight className="size-3" />
                </li>
              )}
              <li
                aria-current={last ? 'page' : undefined}
                className={item.filename ? 'min-w-0 truncate' : undefined}
                title={last ? title : undefined}
              >
                {item.to && !last ? (
                  <Link
                    to={item.to}
                    className={item.filename ? `${linkClass} block truncate` : linkClass}
                    title={title}
                  >
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Shared loading / 404 / error states for recording-scoped pages.
 * Returns null once data is available.
 */
export function recordingStateFallback(
  state: AsyncState<unknown> & { reload: () => void },
  opts: {
    loadingLabel: string;
    backTo: string;
    backLabel: string;
    /** Tailwind height for the middle skeleton block. */
    midHeight?: string;
  },
): ReactNode {
  if (state.status === 'loading') {
    return (
      <div role="status" className="grid gap-6">
        <span className="sr-only">{opts.loadingLabel}</span>
        <Skeleton className="h-8 w-64" />
        <Skeleton className={`${opts.midHeight ?? 'h-24'} w-full`} />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (state.status === 'error') {
    if (state.error instanceof ApiRequestError && state.error.status === 404) {
      return (
        <EmptyState
          headingLevel={1}
          icon={<FileQuestion aria-hidden />}
          title="Recording not found"
          description="It may have been removed, or it belongs to another workspace."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to={opts.backTo}>{opts.backLabel}</Link>
            </Button>
          }
        />
      );
    }
    return <ErrorState error={state.error} onRetry={state.reload} />;
  }
  return null;
}
