import { workspaces } from './schema.js';
import type { Database } from './client.js';

/**
 * Fixed ID of the local development workspace. Authentication and workspace membership are
 * deferred (OD-08b, OD-27); in development the API's dev principal belongs to this workspace only.
 */
export const DEV_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

/** Idempotent. Creates only the development workspace; never creates recordings. */
export async function seedDevelopment(db: Database): Promise<void> {
  await db
    .insert(workspaces)
    .values({ id: DEV_WORKSPACE_ID, name: 'Development workspace' })
    .onConflictDoNothing({ target: workspaces.id });
}
