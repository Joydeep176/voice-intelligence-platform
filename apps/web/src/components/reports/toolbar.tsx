import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { REPORT_SORTS, type ReportSortKey } from './model';

export function ReportsToolbar({
  query,
  onQuery,
  sort,
  onSort,
}: {
  query: string;
  onQuery: (value: string) => void;
  sort: ReportSortKey;
  onSort: (value: ReportSortKey) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-center sm:justify-between">
      <div className="relative">
        <label htmlFor="reports-search" className="sr-only">
          Search reports by recording filename
        </label>
        <Search
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input
          id="reports-search"
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
      <div className="flex items-center gap-2">
        <label htmlFor="reports-sort" className="text-muted-foreground text-sm">
          Sort
        </label>
        <select
          id="reports-sort"
          value={sort}
          onChange={(e) => onSort(e.target.value as ReportSortKey)}
          className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 h-9 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3"
        >
          {REPORT_SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
