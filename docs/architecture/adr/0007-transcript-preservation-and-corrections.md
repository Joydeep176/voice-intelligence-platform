# ADR-0007: Transcript preservation, script, derived representations and corrections

- Status: Accepted
- Date: 2026-11-19
- Resolves: OD-13, OD-22, OD-24a. Also covers approved correction E3 (speaker display names).
- Affects: SRS FR-4.3–4.6, FR-12.x; DATABASE transcription tables; API §5

## Decision
- Original STT and diarization provider output is stored immutably.
- The original script and code-switching are preserved as produced.
- Transliteration, translation and normalisation are separate, versioned derived representations.
- User corrections create new transcript versions. They never overwrite provider output or earlier versions.
- Speaker display names are editable and separate from immutable machine speaker IDs.

## Consequences
Layers: raw output → machine version v1 → correction versions → derivations. How derivations are generated and triggered: OD-24b (Open). Processing of corrected versions: ADR-0020.
