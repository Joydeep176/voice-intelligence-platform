# ADR-0006: Report formats and language

- Status: Accepted
- Date: 2026-11-19
- Resolves: OD-12
- Affects: SRS FR-9.4, AGENT A6, API §7, DATABASE reports

## Decision
- HTML is the primary in-app report. PDF and DOCX are exports.
- English is the default report language; Hindi is an additional option (`reportLanguage`).

## Consequences
A structured report model (assertions with provenance) is the single source for HTML rendering and both exports. Export rendering tooling needs approval (OD-25).
