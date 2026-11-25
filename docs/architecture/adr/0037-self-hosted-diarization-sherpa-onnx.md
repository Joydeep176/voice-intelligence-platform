# ADR-0037: Self-hosted diarization: sherpa-onnx, pyannote segmentation 3.0 and CAM++, windowed above 10 min

- Status: Accepted (selection delegated by the user, 2026-11-24). Threads amended by ADR-0041 (accepted).
  The accuracy threshold (SRS NFR-4) is undecided: a deferral is proposed in ADR-0042, awaiting the user's decision.
- Date: 2026-11-24 (selection); written 2026-11-25 with the validation evidence
- Resolves: OD-03b (HLD §10), including the ADR-0016 threshold and windowing algorithm (NFR-7)
- Affects: `services/audio` (`domain/diarize.py`, `inference_models.py`), `apps/orchestrator/src/providers/diarization/sherpa-onnx.ts`,
  `infra/docker/compose.yaml`, LLD §4.7, DEPLOYMENT_ARCHITECTURE

## Context

- **Requirements:**
  - FR-4.6: speaker IDs consistent across the whole recording, including recordings over two hours.
  - NFR-7: bounded memory for any length.
  - FR-4.4: immutable raw output.
- **ADR-0016:** chose bounded-memory diarization and left the threshold and the algorithm open.
- **ADR-0034:** no paid services or dependencies.
- **Excluded:** `pyannote.audio`, which needs PyTorch and gated models.

## Options considered

C3 (`docs/development/phase2c-stt-benchmark/`): synthetic TTS conversations with 2–4 speakers, 2–10 min, plus one
60 min file. DER is scored with a 250 ms collar, overlaps scored; percent.

| Candidate | DER, dev-tuned threshold (2 / 3 / 4 speakers) | DER, oracle speaker count | RTF at 1 CPU (5 min) | 60 min whole file |
| --- | --- | --- | --- | --- |
| **sherpa-onnx + pyannote seg-3.0 + 3D-Speaker CAM++** | 14.7 / 21.4 / 6.1 | 3.1 / 2.8 / 3.1 | 1.14 | RTF 1.24, DER 25.2, anon 423 MiB |
| sherpa-onnx + pyannote seg-3.0 + WeSpeaker ResNet34 | 14.9 / 18.2 / 9.9 | 5.1 / 21.4 / 29.7 | 5.38 | RTF 5.94, DER 17.1, anon 401 MiB |

CAM++ is about 4.7× cheaper and far better when the speaker count is right. WeSpeaker is somewhat better on the 60 min
whole file, but at a cost the hardware cannot carry.

## Decision

**sherpa-onnx 2.0.2 (Apache-2.0), running pyannote segmentation-3.0 (ONNX export, MIT) and 3D-Speaker CAM++ en
VoxCeleb 16 kHz (Apache-2.0), in the audio service's `diarize` task.**

- **Models:** pinned and verified, mounted read-only: segmentation SHA-256 `220ad67c…1079`, embedding `98daf9bc…8bb5`.
  Never downloaded at runtime.
- **Settings:** clustering threshold 0.6 (dev-tuned); minimum speech 300 ms; minimum silence 500 ms.
- **Bounded memory (ADR-0016, NFR-7):**
  - Recordings up to 10 min are diarized whole.
  - Longer recordings use 10 min windows with 30 s overlap. Each window speaker gets one CAM++ embedding.
  - Window speakers are matched across windows greedily one-to-one at cosine ≥ 0.5. Dev DER was flat for thresholds
    0.3–0.7, and 0.5 is its midpoint.
  - Turns are clipped to each window's owned span.
- **Isolation:** the same sandboxed child process as STT (ADR-0036); 2 threads on 2 CPUs (ADR-0041).
- **Selection:** `DIARIZATION_PROVIDER=sherpa-onnx`. The fake adapter stays for development and tests (OD-03a).

## Evidence

- **Windowed against whole-file on the 10 min test conversations** (DER, 2 / 3 / 4 speakers): windowed 17.4 / 10.4 /
  7.0, whole 22.5 / 26.4 / 5.9. Source: `docs/development/phase2c-provider-validation/windowed-test.json`.
- **60 min file, production windowing (7 windows):** DER 7.7, against 25.2 whole-file. 11 speakers found for 4 in the
  reference. Source: `windowed-long.json`.
- **Real service:**
  - 90 s clip: 49.3 s (RTF 0.55, 2 threads), 5 speakers, 14 turns.
  - The 5 min whole file earlier, at 1 CPU: anonymous peak 282.8 MiB.
  - Bounded-memory run of the 60 min file inside the production container: see the Phase 2B/2C acceptance report.
- **Browser end-to-end:** 4 speakers on the 90 s clip; every segment but one was attributed; one `speaker_uncertain`
  marker.

## Consequences and limitations

- **Accuracy threshold:** NFR-4 is undecided (deferral proposed in ADR-0042, awaiting the user's decision). This ADR reports DER and sets no threshold.
- **Over-clustering:** with the dev-tuned threshold the speaker count is often too high (4–9 found on 5–10 min files;
  11 for 4 on 60 min). Speaker display names (FR-12.2) let users merge labels by naming; there is no automatic merge.
- **Corpus limits:** overlaps are rare in the corpus (under 1 % of reference speech), so overlap handling is barely
  tested. The corpus is synthetic TTS only.
- **Embedding model:** CAM++ is trained on English VoxCeleb. Its behaviour on Hindi speakers is unmeasured beyond the
  synthetic corpus.
