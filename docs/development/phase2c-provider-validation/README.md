# Phase 2C provider validation evidence (self-hosted STT and diarization)

Numbers, codes and IDs only. All inputs are synthetic (ADR-0004). Summary and verdicts:
`../PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md`.

| Folder or file | What it shows |
| --- | --- |
| `e2e-real-providers-2026-11-25/` | Browser end-to-end with the real providers: the happy path (`mixed90`, `hinglish33`) and failure paths (`fail-*`), with their scripts |
| `stt-speed-2026-11-24/` | B-1 investigation: E1–E10, the E7 accuracy gate, E8 CPU scaling, the 2-CPU real check (ADR-0041), span density (E10) |
| `diarize-60min-bounded-memory-2026-11-25/` | 60 min windowed diarization in the 768 MB / 2 CPU container: anonymous peak 524 MiB, no OOM |
| `responsiveness-check-2026-11-24.json` | Liveness under real inference after the child-process isolation fix (1 CPU) |
| `windowed-tune.json`, `windowed-test.json`, `windowed-long.json` | Windowed diarization tuning and DER (ADR-0037) |
