# ADR-0028: IBM Plex fonts, self-hosted

- Status: Accepted
- Date: 2026-11-20
- Resolves: OD-38
- Affects: `apps/web`, `.claude/skills/frontend-design` (`tokens-and-themes.md`, `performance.md`, `SKILL.md`)

## Context
The UI uses a system font stack with Devanagari-capable faces until a font is chosen (OD-38). The product
must render English, Hindi and Hinglish (mixed script) correctly. The Phase 2A redesign needs a distinctive
but enterprise-credible typeface, with a fonts budget of at most two preloaded files (≤ 80 KB) and at most
200 KB in total (`docs/design/phase2a-m0-baseline/README.md` §5).

## Options considered
1. **System font stack**: no cost, but inconsistent across platforms and generic.
2. **Inter with Noto Sans Devanagari**: widely used; two unrelated families with different proportions.
3. **IBM Plex Sans, IBM Plex Sans Devanagari and IBM Plex Mono**: one superfamily covering Latin,
   Devanagari and monospace with matched proportions; SIL Open Font License.

## Decision
The user approved **IBM Plex Sans, IBM Plex Sans Devanagari and IBM Plex Mono** on 2026-11-20 (Phase 2A
D4), **self-hosted**: WOFF2 files served by the application, limited to the weights and subsets actually
used. No paid font service and no third-party font CDN at runtime.

## Consequences
- Font files come from the official IBM Plex release under the OFL; the licence text is kept alongside
  the files.
- Only the needed weights and subsets are shipped; at most two files are preloaded. `font-display` and
  fallback metrics avoid layout shift (CLS budget ≤ 0.05).
- The Devanagari face is included wherever transcript or report text can appear; mixed-script lines are
  tested for line height and clipping.
- Monospace (Plex Mono) is used for identifiers, hashes and code-like values; timestamps and counts keep
  tabular numerals.
- The system font stack remains the fallback.
- Added in M1.
