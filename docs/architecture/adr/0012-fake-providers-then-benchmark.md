# ADR-0012: Fake STT/diarization adapters first; benchmark before production

- Status: Accepted (2026-11-24: the benchmark was run and the selection made, ADR-0036 / ADR-0037; the fakes remain for development and tests, ADR-0040)
- Date: 2026-11-19
- Resolves: OD-02a, OD-03a. Production selection: OD-02b (ADR-0036) and OD-03b (ADR-0037).
- Affects: LLD §2.2, TESTING §4, DEPLOYMENT §1

## Decision
Development uses fake transcription and diarization adapters. Real providers (managed and/or self-hosted pyannote.audio) are benchmarked on English, Hindi and Hinglish (WER/CER, DER, including > 2 h audio) before production selection.

## Consequences
No real provider integration is described as implemented until it is selected, integrated and passes contract tests. Benchmarks depend on a test corpus (OD-18).
