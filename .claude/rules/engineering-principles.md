# Engineering principles

Adapted from the community `forrestchang/andrej-karpathy-skills` guidelines (not an official Karpathy or Anthropic release). Complements the Working rules in `CLAUDE.md`; project docs and ADRs win on conflict.

- **Think first.** State assumptions before coding. If a request has several readings, name them and ask; do not pick one silently. Say so when a simpler approach exists.
- **Simplicity.** Write only what the task needs: no speculative options, configurability or single-use abstractions, and no handling for impossible cases. This never cuts validation at trust boundaries, workspace isolation, provenance, bounded workers or other ADR guarantees.
- **Surgical diffs.** Match the surrounding style. Every changed line traces to the request. Remove only orphans your own change created. Mention unrelated dead code; do not delete it.
- **Success criteria.** For multi-step work, state each step with its check (`step → verify: test/command`) before starting, then verify with the `verify-change` skill.
