# ADR-0023: FastAPI for the audio service (provisional)

- Status: Accepted (prototype confirmed: FastAPI stayed confined to the adapter; ADR-0040, 2026-11-24)
- Date: 2026-11-19
- Resolves: OD-23a
- Affects: LLD §2.3, §3.1; `services/audio`; `.claude/rules/python-audio.md`

## Context
ADR-0002 requires a Node↔Python prototype before the integration design is final, and requires the audio-service contract to stay framework-independent. Phase 1 needs an HTTP framework to build that prototype. FastAPI was the Proposed choice.

## Options considered
1. **FastAPI + uvicorn**: Pydantic request validation, automatic OpenAPI, async support and a mature test client. Adds a framework dependency.
2. **Python standard library `http.server`**: no dependency, but hand-written validation and routing, and throwaway code.

## Decision
The user chose **FastAPI with uvicorn** on 2026-11-19, provisionally, for the audio service and its prototype.

## Consequences
- The ADR-0002 constraint still applies: domain modules (`probe`, `preprocess`, `measure`, `diarize` and any later ones) must not import FastAPI. Only the `api` adapter layer depends on it.
- Pydantic models in the service mirror the zod schemas in `packages/contracts`. The two change together.
- The choice becomes permanent only once the ADR-0002 prototype validates the integration (async tasks, polling, cancellation, restart behaviour, limits). If the prototype fails, this ADR is revisited.
- Service-to-service authentication remains Open (OD-23b). Update 2026-11-21: resolved for development by ADR-0035; production is OD-23c (Open).
