---
paths:
  - "apps/web/**"
---

# Frontend rules

- React + TypeScript + Vite, Tailwind CSS and shadcn/ui only. Types from `packages/contracts`.
- Fetch transcripts by time range. Never load a whole long transcript at once.
- Uploads: consent attestation plus a resumable multipart session (API §2).
- Show provenance per report assertion. Render audio limitations and transcription uncertainty as separate sections.
- Never overwrite provider text in the UI model. Corrections create new versions. Render Devanagari and mixed script correctly.
- Do not log transcript content to the console or analytics.
- For design, layout, theming, motion, visualisation, evidence display, 3D or performance work, use the `frontend-design` skill. Introduce no new frontend dependency without explicit approval.
- Tests: Vitest + Testing Library; Playwright for e2e.
