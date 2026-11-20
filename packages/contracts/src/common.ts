import { z } from 'zod';

/** All IDs are UUIDs (API §1). */
export const Uuid = z.uuid();
/** All times are ISO 8601 UTC strings (API §1). */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Cursor pagination envelope: `?limit=&cursor=` → `{ items, nextCursor }` (API §1). */
export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;
