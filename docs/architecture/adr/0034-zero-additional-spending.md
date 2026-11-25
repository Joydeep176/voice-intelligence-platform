# ADR-0034: Zero additional spending (architecture and procurement constraint)

- Status: Accepted
- Date: 2026-11-21
- Resolves: OD-46 (new)
- Addresses: conflicts with SRS C-2, HLD §2 "Primary LLM", ADR-0013 / OD-07, OD-03b and the OD-05 suggestion (flagged, not changed)
- Affects: HLD §2 and §10, SRS §2 constraints, provider adapters (STT, diarization, research, LLM), deployment, dependency selection

## Context
The user set a strict zero-additional-spending requirement for the project (2026-11-21, Phase 2A M8 brief). Several earlier
records assume paid runtime services: SRS C-2 and HLD §2 name the Anthropic Claude API as the primary LLM, ADR-0013
configures a Claude model per agent, the assistant suggestion on OD-05 is Claude server-side web search, and OD-03b
compares pyannote.audio with a managed (possibly paid) diarization service. The development machine is an Apple M1 with
8 GB unified memory and a 512 GB SSD (corrected 2026-11-21; first recorded as an Apple M2 with 16 GB, see Amendment).

## Options considered
1. **Record a project-wide constraint now and keep provider decisions open**: makes the rule binding for every later
   decision without choosing replacements before their phases. Leaves known conflicts to resolve later.
2. **Record the constraint and select replacement providers now**: premature; no benchmarks, licence or hardware checks.
3. **Leave the constraint unrecorded**: earlier records would keep implying paid services.

## Decision
Option 1 (user decision).
- **Development assistance:** the existing Claude Code / Claude Pro access may continue to be used for development
  assistance. It is not API credit and is not part of the product runtime.
- **Production runtime:** the platform must not depend on paid Anthropic API calls or any other paid runtime AI API.
- **Preferred sources:** locally executable open-source models, free Hugging Face models and datasets, self-hosted GitHub
  projects, existing project dependencies and the existing Docker infrastructure.
- **Before adoption:** evaluate licence (including commercial-use restrictions), maintenance, hardware compatibility with
  the Apple M1 (8 GB unified memory, 512 GB SSD) machine, and resource consumption.
- **Not allowed:** new subscriptions, paid services or SaaS, commercial or paid-tier dependencies, paid datasets, and cloud
  expenditure.
- **No premature selection:** replacement providers for speech-to-text, diarization, research and LLM inference are not
  chosen here. OD-02b, OD-03b and OD-05 stay Open; production LLM inference is a new Open decision (OD-47). Each is decided
  in its own architecture phase, within this constraint.

## Consequences
- Existing ADRs are not changed. ADR-0013 (configurable model per agent, cost tracking) stays Accepted, but its assumption
  of a paid Claude API now conflicts with this ADR. The conflict is flagged on OD-07, HLD §2 and SRS C-2 and must be
  resolved, through OD-47, before the agent phase starts.
- The OD-05 suggestion (Claude server-side web search) and the "managed" option in OD-03b conflict with this ADR and are
  flagged in the register. Any OD-05 resolution must be free and self-hostable, and must still satisfy ADR-0009 and
  ADR-0017 (minimised queries, fetched snapshots).
- Other references to a paid key or provider (DEPLOYMENT_ARCHITECTURE environment groups, the HLD context diagram,
  historical ARCHITECTURE_REVIEW options) are to be revisited when OD-47 and OD-05 are decided. Historical records stay as
  written.
- Local inference on 8 GB unified memory strictly limits model size and concurrency. Bounded workers and the cost-ceiling design
  (ADR-0010, OD-28) remain, with cost measured in compute and time instead of money.

## Amendment (2026-11-21): hardware correction
Factual correction only; the decision is unchanged. The ADR was first recorded with the development machine as an
"Apple M2 with 16 GB unified memory". The user verified the target as an **Apple M1, 8 GB unified memory, 512 GB SSD**
(Phase 2B planning, D-2B-17; confirmed in the Phase 2B implementation brief). The Context, Decision and Consequences
lines above were corrected; original wording: Context "an Apple M2 with 16 GB unified memory", Decision "the Apple M2
16 GB machine", Consequences "Local inference on 16 GB unified memory limits model size and concurrency".
