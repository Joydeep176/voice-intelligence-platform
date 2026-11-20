# Self-hosted fonts (ADR-0028)

Official IBM Plex WOFF2 files, **unmodified** (only renamed where the upstream name contained spaces),
licensed under the SIL Open Font License 1.1 (`OFL.txt`). Because the licence reserves the font name
"Plex", files are never subset or otherwise modified here; only official upstream files are shipped.

| File                                  | Source package (npm, tarball integrity verified) | Upstream file                                              | Bytes   | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `IBMPlexSansVar-Roman-Latin1.woff2`   | `@ibm/plex-sans-variable@0.2.0`                  | `fonts/split/woff2/IBM Plex Sans Var-Roman-Latin1.woff2`   | 68,988  | `a18d94ea83c93f0a465d0976d8bc8ecbb031225dbaf76fd201d4e724a972034f` |
| `IBMPlexMono-Regular-Latin1.woff2`    | `@ibm/plex-mono@2.5.0`                           | `fonts/split/woff2/IBMPlexMono-Regular-Latin1.woff2`       | 17,544  | `e8993d946649b9d01abb1ed06d574b19d8ea3e66b5c3948602db335c44c18e56` |
| `IBMPlexSansDevanagari-Regular.woff2` | `@ibm/plex-sans-devanagari@1.1.0`                | `fonts/complete/woff2/IBMPlexSansDevanagari-Regular.woff2` | 103,908 | `9414954cbb343be6c8fa97b716a93eb7cd5501043356cdbb704e233db5f8ca85` |

How they load (`src/styles/fonts.css`):

- **Plex Sans** is a variable font (`wght` 100–700) restricted to the upstream Latin-1 `unicode-range`. It
  is the only preloaded file (`index.html`).
- **Plex Mono** Regular, Latin-1 range, loads only when monospace text is rendered.
- **Plex Sans Devanagari** Regular, restricted to Devanagari code points, loads only when Devanagari
  text is rendered. Heavier Devanagari weights are deferred until transcript and report screens need
  them (font budget: `docs/design/phase2a-m0-baseline/README.md` §5); until then the browser
  synthesises bold.
- Characters outside these ranges fall back to the system font stack.

To update: download the official package version, verify its tarball integrity against the npm
registry, copy the files unchanged and update this table.
