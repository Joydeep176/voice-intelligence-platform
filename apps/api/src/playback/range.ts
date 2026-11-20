export type RangeResult =
  { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

const SINGLE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a single HTTP byte range (RFC 9110 §14). Malformed headers, other units and
 * multi-range requests are ignored (served in full). `end` is inclusive.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined || size <= 0) return { kind: 'full' };
  const match = SINGLE.exec(header.trim());
  if (!match) return { kind: 'full' };
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return { kind: 'full' };
  if (first.length > 15 || last.length > 15) return { kind: 'full' };

  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size || start > end) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end };
}
