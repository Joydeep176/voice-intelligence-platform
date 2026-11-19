# ADR-0004: Interim development data policy

- Status: Interim
- Date: 2026-11-19
- Resolves: OD-09a. The production policy (OD-09b) remains Open and blocks production.
- Affects: SRS C-6, SEC-1, TESTING §5, DEPLOYMENT §1

## Decision
Development and testing use only synthetic or explicitly consented audio. Full privacy and data-handling policies (retention defaults, consent wording and legal basis, vendor data processing and retention, residency, backups) must be defined before production.

## Consequences
No real user recordings or private transcripts in development environments, fixtures, logs or Git.
