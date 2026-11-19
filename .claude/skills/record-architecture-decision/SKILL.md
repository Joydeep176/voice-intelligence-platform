---
name: record-architecture-decision
description: Record an architecture decision as an ADR and update the decisions register (HLD §10). Use when the user resolves an OD-xx item, approves a deviation or a Proposed design, or approves a new requirement.
---

# Recording an architecture decision

1. Statuses: `Accepted`, `Accepted provisionally` (user decided, subject to validation), `Interim` (an approach for now; final decision pending), `Proposed`, `Open`. Only the user's decision may be `Accepted`. Your own recommendation is `Proposed` (in an ADR) or a noted suggestion on an `Open` row. If a decision only settles part of its scope, split the register row (a/b) so each row has one status.
2. Next number in `docs/architecture/adr/` → `NNNN-kebab-title.md`, from `docs/templates/ADR_TEMPLATE.md`. Set `Resolves:`/`Addresses:`.
3. Update the HLD §10 row (status + ADR link). Add new ODs that the decision creates.
4. Update every reference: `grep -rn "OD-xx" docs CLAUDE.md .claude`. Replace TBD values in the SRS. Verify that no row is marked resolved while part of its scope is unsettled.
5. Update affected `.claude/rules` and skills.
6. If it supersedes an ADR, set the old one to `Superseded by ADR-NNNN`.
7. Summarise the changed files for the user.
