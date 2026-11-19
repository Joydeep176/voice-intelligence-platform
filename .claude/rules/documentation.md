# Documentation & decision rules

- `docs/` and `docs/architecture/adr/` are the source of truth. Update the matching doc in the same change as the behaviour.
- Never resolve an Open/Proposed `OD-xx` (HLD §10) or a *Proposed* design in code. Ask the user, then use the `record-architecture-decision` skill.
- Do not add requirements, endpoints, tables, agents or dependencies that the docs do not contain without approval.
