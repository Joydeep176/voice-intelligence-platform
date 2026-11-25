# ADR-0040: Phase 2B / 2C closure: accepted implementation decisions and remaining items

- Status: Accepted (user-authorised resolution of the Phase 2B/2C decision items, 2026-11-24). **Corrected 2026-11-26 at
  the user's direction: this ADR does not record acceptance of Phase 2B or Phase 2C.** **Phase 2B and Phase 2C were then
  formally accepted by the user on 2026-11-26** (separate from this ADR's decision items).
- Date: 2026-11-24
- Resolves: OD-18, OD-39 (as a deferral), OD-23a; splits OD-04 into OD-04a (Accepted) and OD-04b (Accepted
  provisionally)
- Affects: HLD §10, ADR-0002, ADR-0012, ADR-0018 (unchanged), ADR-0023, `docs/development/PHASE2B_*`,
  `docs/development/PHASE2C_*`

## Context

On 2026-11-24 the user approved the work to close Phase 2B (audio processing foundation) and Phase 2C (transcription
and diarization foundation). They asked that the providers (ADR-0036 / ADR-0037) and the remaining Phase 2B/2C
decision items be resolved in line with the recorded evidence and recommendations. This was an authorisation to
resolve decisions and complete the closure work; it was **not** final acceptance of either phase (see Correction). The items are listed in
`PHASE2B_COMPLETION.md` §9:

- the D-2B decisions;
- OD-10 and D-2B-20 (both ADR-0039);
- OD-29 (ADR-0038) and OD-18 / D-2B-14;
- OD-39, the lossy-timestamp target (ADR-0039), the librosa deferral, the synthetic development recordings, and the
  ADR-0002 / ADR-0018 / ADR-0023 prototype outcome.

## Decision

1. **Phase 2B implementation decisions accepted as built** (definitions: `PHASE2B_PLAN_DRAFT.md` §15):

   | Decision | What it covers |
   | --- | --- |
   | D-2B-01 | Ownership: API / orchestrator coordinator / Python; recording-scoped processing; no LangGraph |
   | D-2B-02 | Measurement boundary |
   | D-2B-03 | Processing in the audio container |
   | D-2B-04 | Storage design |
   | D-2B-05 | Migration inventory |
   | D-2B-06 | Internal contract v2 and browser endpoints |
   | D-2B-07 | Database snapshot polling; SSE deferred to OD-16 |
   | D-2B-09 | FFmpeg security boundary |
   | D-2B-11 | Dependencies: NumPy; Silero and onnxruntime only if selected, now through sherpa-onnx (ADR-0038); librosa deferred |
   | D-2B-12 | Canonical mono 16 kHz s16 WAV |
   | D-2B-15 | Trigger rules |
   | D-2B-16 | Minimal processing UI |

   D-2B-08 is ADR-0035 and D-2B-17 the ADR-0034 amendment (both already recorded). D-2B-10 (VAD selection process)
   is completed by ADR-0038, D-2B-18 to D-2B-20 by ADR-0039, and D-2B-14 by item 3 below. D-2B-13 (waveform peaks)
   follows OD-39 (item 4).
2. **Phase 2C implementation decisions accepted as built:**
   - **D-2C-01:** the orchestrator coordinator runs the stage scope (transcription, diarization) without LangGraph.
     It is replaced when the agent phase introduces LangGraph.
   - **D-2C-02:** transcription windows are VAD segments when preprocessing has them, else 30 s / 1 s windows. Speech
     spans inside each window come from ADR-0038.
   - **D-2C-03:** fake adapters first. Completed: the user delegated the selection, and ADR-0036 / ADR-0037 record
     it. The fakes remain the default for tests and development without models (`STT_PROVIDER=fake`).
3. **OD-18 (test audio corpus), Accepted.** The licence-checked list in `PHASE2B_PLAN_DRAFT.md` §17 is approved for
   a real-speech benchmark: Common Voice (CC0, release terms), FLEURS (CC BY 4.0), LibriSpeech (CC BY 4.0),
   MUCS 2021 code-switching (CC BY-SA 4.0), MUSAN and DEMAND noise, and consented internal recordings (ADR-0004).
   Non-commercial sets are excluded. Licences are re-checked at download, and the corpus is kept outside the
   repository with a manifest. Downloading and running that benchmark is follow-up work. Until it is done, all
   provider accuracy evidence is synthetic.
4. **OD-39 (server-side waveform peaks), Accepted as deferred,** per its register wording ("for later
   consideration"). `level-series.json` is never served as peaks, and the decision is made when the waveform UI is
   built.
5. **librosa stays deferred** (NumPy only), as recorded in HLD §2.
6. **The synthetic development recordings are kept.** No database records are deleted.
7. **Prototype outcome:**
   - **OD-04a (ADR-0002), Accepted.** Node owns BullMQ and the job lifecycle; the Python service is behind an
     internal API. The Phase 2B prototype confirmed this, including restart recovery and back-pressure, and Phase 2C
     reuses it for inference.
   - **OD-04b, Accepted provisionally until the agent phase.** "LangGraph orchestrates" has not been exercised.
   - **OD-23a (ADR-0023), Accepted.** FastAPI stayed confined to the adapter.
   - **ADR-0018 stays Accepted provisionally.** Only its polling fallback was exercised; the transport is OD-16
     (Proposed).

## Correction (2026-11-26)

The original status line and context said the user *accepted* Phase 2B and Phase 2C on 2026-11-24. That was wrong. The
user approved the closure work and the resolution of the decision items listed above, and kept final acceptance for
themselves. The decisions in this ADR (D-2B / D-2C as built, OD-18, OD-39 deferral, OD-04a/b, OD-23a, ADR-0018) are
unchanged.

**Phase status:** Phase 2B and Phase 2C were formally accepted by the user on 2026-11-26, with known limitations and open items (accuracy
thresholds NFR-3 / NFR-4 still TBD per the Proposed ADR-0042). See `docs/development/PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md`.

## Consequences

- The HLD register, the ADR-0002 / ADR-0023 statuses, `PROJECT_STATUS.md` and the phase records are updated in the
  same change.
- The real-speech benchmark (OD-18), production deployment (OD-48) and LLM inference (OD-47) remain follow-up work,
  outside Phase 2B/2C.
