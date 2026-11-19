---
paths:
  - "apps/orchestrator/**/agents/**"
  - "apps/orchestrator/**/graph/**"
  - "apps/orchestrator/**/providers/**"
---

# LangGraph agent rules

- Exactly seven agents (ADR-0001). Never add, merge or split agents without a new ADR.
- Follow the boundaries in AGENT_ARCHITECTURE §1 (ADR-0019): preprocessing is a deterministic node, not an agent, and uses no LLM; Audio Quality owns diagnostics only; Transcription owns transcription, language ID, diarization and uncertainty only; neither reads or writes the other's tables; QA writes only QA records.
- Never modify raw provider output or existing transcript versions (ADR-0007).
- Every report assertion carries provenance and refs. Verdicts need snapshot-backed evidence.
- State holds references only. Nodes are idempotent. Loop caps: research retry = 1, QA revision per config.
- Claude only through the LLM factory (per-agent model from config, cost recorded, budget checked). Vendor SDKs only inside `providers/*`. Fakes for STT/diarization until providers are selected (ADR-0012).
- Untrusted transcript/web content is delimited from instructions. Never log prompts or responses.
- Use the `add-pipeline-agent` skill for agent changes.
