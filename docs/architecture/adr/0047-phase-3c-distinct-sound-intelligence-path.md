# ADR-0047: Phase 3C machinery and environmental sound intelligence as a distinct path, and the SRS C-4 amendment

- Status: **Accepted** (user decision, 2026-11-26). First written as Proposed in the Phase 3A plan from the user's
  architecture-review corrections (2026-11-26). Phase 3C's own design is still to be decided in Phase 3C
- Date: 2026-11-26
- Addresses: OD-53 (Accepted); plan decision D-3A-12
- **Amends:** SRS C-4 ("Exactly seven product agents …", ADR-0001 / ADR-0019)
- Affects: SRS §2 C-4, AGENT_ARCHITECTURE §1 (a note), HLD §10, the roadmap in
  `docs/development/phase3a/MULTI_AGENT_ARCHITECTURE.md`

## Context

- **The roadmap** (user-defined) has Phase 3C, machinery and environmental sound intelligence, between A3 and A4.
- **SRS C-4** fixes exactly seven product agents, A1–A7, with fixed responsibilities.
- **The earlier plan draft** considered placing Phase 3C inside A1 or A3 to keep the count. The user rejected that
  (2026-11-26): A1–A7 identities and responsibilities stay as they are, and 3C must be a **distinct** intelligence
  workflow or capability. It still shares the platform's audio infrastructure, storage, contracts, orchestration and
  observability, and is not a separate product or stack.
- The user's earlier constraint stands: machine-sound intelligence is not implemented before its phase.

## Options considered

1. **Fold 3C into A1 or A3.** Rejected by the user: it blurs A1's audio-quality and A3's transcript-context
   responsibilities.
2. **A distinct capability path inside the platform**, with C-4 amended so that the seven agents stay fixed while
   additional intelligence capabilities may exist. Whether 3C is itself an agent (A8) or a non-agent capability is
   decided at Phase 3C planning.
3. **A separate product or stack.** Excluded by the user.

## Decision

**Option 2. Reserve the path now; design it in Phase 3C.**

**C-4 text (applied to the SRS):** "The seven product agents A1–A7 and their responsibilities are fixed (ADR-0001). Ingestion and
preprocessing are deterministic and are not agents (ADR-0019). Additional intelligence capabilities, starting with
Phase 3C machinery and environmental sound intelligence, are distinct workflows within the same platform. They share
its audio service, storage, contracts, orchestration and observability, and do not take over any A1–A7
responsibility. Whether such a capability is modelled as an additional agent is decided, through an ADR, in its own
phase."

**Reserved integration points.** These are reserved only; nothing is implemented in 3A.
- **Audio service:** a future task type, measurement or inference only, sandboxed and resource-bounded, following the
  `measure` pattern.
- **Orchestration:**
  - a node, or nodes, in the shared graph after preprocessing;
  - its own stage-node enum value and its own state key;
  - no dependency of A1–A5 on it.
- **Data:** its own tables, written only by it.
- **A1 boundary:**
  - A1 reports *that* background sound is loud or noisy. It never says *what* the sound is.
  - 3C may read A1's summary as read-only metadata under ADR-0046's rules.
  - A1's contracts gain nothing for 3C in Phase 3A.
- **Consumers:** A6 (report section) and A7 (checks), decided in 3C.

## Consequences

- SRS C-4 is amended. AGENT_ARCHITECTURE §1 gains a note that capabilities outside A1–A7 may exist.
- Phase 3C planning must decide:
  - agent or capability;
  - its model or algorithm within ADR-0034;
  - its contracts;
  - where it sits in the graph.
- The Phase 3A plan no longer describes any A1 "extension point" for 3C.
