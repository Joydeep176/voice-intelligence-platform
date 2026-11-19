# ADR-0013: Configurable Claude model selection and cost tracking

- Status: Accepted
- Date: 2026-11-19
- Resolves: OD-07
- Affects: AGENT §5, LLD providers/llm, DATABASE `llm_calls`, SRS OPS-6

## Decision
The Claude model for each agent comes from configuration and is never hard-coded. Token usage and estimated cost are tracked per call and per run.

## Consequences
The model assigned to each agent is a configuration value, chosen during implementation and evaluation.
