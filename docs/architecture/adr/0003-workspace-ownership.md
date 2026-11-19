# ADR-0003: Workspace-based data ownership and isolation

- Status: Accepted
- Date: 2026-11-19
- Resolves: OD-08a. The authentication provider (OD-08b) and roles/authorisation/DB isolation (OD-27) remain Open.
- Affects: SRS SEC-2/3, DATABASE §1–2, API §1

## Decision
All data is owned by exactly one workspace. Every tenant-owned table has `workspace_id`. Every API route is workspace-scoped and needs workspace membership. Cross-workspace access returns `404`. The final authentication provider is deferred.

## Consequences
Repository-layer workspace filtering is mandatory. The role model and Postgres RLS are OD-27.
