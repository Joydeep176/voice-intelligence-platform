/**
 * Development workspace. Authentication and workspace selection are not implemented
 * (OD-08b, OD-27); the API treats every request as the local development principal.
 */
export const WORKSPACE_ID: string =
  import.meta.env.VITE_DEV_WORKSPACE_ID ?? '00000000-0000-4000-8000-000000000001';

export const WORKSPACE_LABEL = 'Development workspace';
