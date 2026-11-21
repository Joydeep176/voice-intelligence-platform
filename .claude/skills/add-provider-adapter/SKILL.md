---
name: add-provider-adapter
description: Procedure for adding a provider implementation behind the speech-to-text, diarization or research adapter interfaces — including fake adapters. Use when integrating any vendor or self-hosted model. Real providers require explicit user approval of the selection.
---

# Adding a provider adapter

Read first: LLD §3.2 (interfaces), §8 (config); ADR-0012 (fakes first, benchmark before production); ADR-0017 (research); ADR-0009 (research privacy); OD-02b/03b/05 status in HLD §10.

## Guardrails
- Fake adapters are allowed. A real vendor needs user approval and an ADR. Never install SDKs speculatively.
- Zero additional spending (ADR-0034): no paid APIs, SaaS, subscriptions or paid-tier/commercial dependencies at runtime. Candidates must be free, open-source or self-hosted, with licence, maintenance and Apple M2 16 GB resource checks recorded before approval.
- Never describe a provider as working until its contract tests pass. Production use needs benchmark results.
- Send vendors the minimum data. Document the data flow (SRS SEC-7).

## Steps
1. Implement the interface in `apps/orchestrator/.../providers/<type>/<name>.ts`. Self-hosted models run in `services/audio` and are reached through `audio-client` (ADR-0002). Vendor SDK imports stay in the adapter.
2. STT/diarization: **store the raw provider payload first** (URI + sha256), then map. Offsets in ms relative to the original (add `offsetMs`). Language codes `en|hi|mixed` with code-switch spans. Accurate `capabilities()`.
3. Research: return queries exactly as issued; snapshot fetched content; mark `snippet_only` when content could not be fetched.
4. Map errors to `ProviderError{retryable}` / `QuotaError`. Respect queue rate limits and timeouts.
5. Register under a config key. Add variable names (never values) to `.env.example` and DEPLOYMENT §4.
6. Pass the shared contract suite with recorded fixtures. Live calls only behind an opt-in flag.
7. For STT/diarization candidates, run the benchmark in TESTING §4 and report results to the user. Do not select a provider yourself.
