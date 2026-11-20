import { ArrowDownUp, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from 'cn';
import { FILTERS, SORTS, type SortKey, type StatusFilter } from './model';

export function RecordingsToolbar({
  query,
  onQuery,
  filter,
  onFilter,
  counts,
  sort,
  onSort,
}: {
  query: string;
  onQuery: (value: string) => void;
  filter: StatusFilter;
  onFilter: (value: StatusFilter) => void;
  counts: Record<StatusFilter, number>;
  sort: SortKey;
  onSort: (value: SortKey) => void;
}) {
  const sortLabel = SORTS.find((s) => s.key === sort)?.label ?? '';
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_auto] lg:items-center">
      <div className="relative">
        <label htmlFor="recordings-search" className="sr-only">
          Search recordings by filename
        </label>
        <Search
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input
          id="recordings-search"
          type="search"
          value={query}
          placeholder="Search filenames"
          autoComplete="off"
          className="h-9 pr-9 pl-8 [&::-webkit-search-cancel-button]:hidden"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              onQuery('');
            }
          }}
        />
        {query ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear search"
            className="absolute top-1/2 right-1 -translate-y-1/2"
            onClick={() => onQuery('')}
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="flex items-center gap-2 lg:contents">
        <div
          role="group"
          aria-label="Filter by status"
          tabIndex={0}
          className="focus-visible:ring-ring/50 -my-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto rounded-lg py-1 outline-none focus-visible:ring-[3px] lg:flex-none"
        >
          {FILTERS.filter((f) => f.key === 'all' || counts[f.key] > 0).map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={active}
                onClick={() => onFilter(f.key)}
                className={cn(
                  'focus-visible:ring-ring/50 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px]',
                  active
                    ? 'bg-foreground text-background border-foreground'
                    : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {f.label}
                <span className={cn('text-xs tabular-nums', active ? 'opacity-80' : 'opacity-70')}>
                  {counts[f.key]}
                </span>
              </button>
            );
          })}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 shrink-0">
              <ArrowDownUp aria-hidden data-icon="inline-start" />
              <span className="sr-only">Sort: </span>
              {sortLabel}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSort(v as SortKey)}>
              {SORTS.map((s) => (
                <DropdownMenuRadioItem key={s.key} value={s.key}>
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
