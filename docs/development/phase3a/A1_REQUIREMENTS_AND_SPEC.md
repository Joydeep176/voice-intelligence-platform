# Phase 3A: Audio Quality Intelligence (A1): requirements and functional specification

- **Status: DRAFT FOR THE USER'S REVIEW (2026-11-26). Nothing here is approved.** The decisions this document depends
  on are listed in `PHASE3A_PLANNING_REPORT.md` §14 (D-3A-00 … D-3A-13) and in the Proposed ADRs 0043–0047.
- Covers deliverables 1 (product requirements) and 2 (functional specification).
- Builds on, and does not repeat:
  - SRS FR-3.1–FR-3.5, FR-9.3, FR-10.2 and FR-11.4;
  - AGENT_ARCHITECTURE §1–§4 (A1 boundaries and contract);
  - DATABASE_DESIGN "Audio Quality Agent output";
  - API_SPECIFICATION §4;
  - ADR-0008, ADR-0015, ADR-0019 and ADR-0021.

Where this draft proposes something that differs from those records, it is marked **[CHANGE, needs approval]**.

## 1. Product requirements (PRD)

### 1.1 Problem

- **What the platform does today:** it transcribes and diarizes every recording the same way. It says nothing about
  whether the audio was fit for that.
- **Where users can see a problem:** only indirectly, through per-segment transcription uncertainty markers. Those
  markers are model confidence, not audio diagnostics (FR-3.3).
- **What users cannot tell:**
  - why a transcript is poor;
  - whether re-recording would help;
  - which parts of a long recording are unreliable.

### 1.2 Users and jobs to be done

| User | Job | What A1 gives them |
| --- | --- | --- |
| Uploader | "Is this recording good enough before I spend 10+ minutes on transcription?" | An overall assessment and plain-language reasons, shown before transcription is started (D-3A-03) |
| Reviewer of a transcript | "Which parts can I trust?" | Timestamped problem regions on the timeline, kept separate from transcription uncertainty |
| Report reader (later, A6) | "What are the audio limitations of this evidence?" | A stable, versioned diagnostics record that the *Audio limitations* section is built from |
| The platform (A6, A7) | Relate limitations to findings, and check that the report does not contradict them | A typed summary and flags with measurement references |

### 1.3 Goals for Phase 3A

- **G1:** For every successfully preprocessed recording, produce an explainable audio-quality assessment:
  - an overall class;
  - a suitability for transcription and for diarization;
  - timestamped flags with a kind, a severity and the measurements behind them;
  - the conditions that were *not assessable*.
- **G2:** Base it only on objective, reproducible measurements of the audio (FR-3.1, FR-3.3), never on transcript
  confidence.
- **G3:** Never block or alter transcription and diarization (ADR-0008, ADR-0021). The assessment informs the user and
  later agents.
- **G4:** Fit the accepted resource envelope: the M1 with 8 GB, the audio service at 768 MB and 2 CPUs. No new runtime
  dependency, no model download, zero spend.
- **G5:** Make every threshold configuration-driven, versioned and evidence-calibrated, and approved by the user before
  acceptance.

### 1.4 Non-goals (Phase 3A)

- **Transcription-side responsibilities:** no transcription, language identification, diarization, overlap detection
  or uncertainty. These belong to A2.
- **Audio changes:** no denoising, enhancement or any change to the audio that A2 receives.
- **Sound-source classification:** no classification of sound sources (machinery, environment). That is Phase 3C, a
  distinct path that is not part of A1 (ADR-0047, *Proposed*).
  A1 reports *that* the background is loud, not *what* it is.
- **Other agents' work:** no claims, topics or report text (A3, A6), and no QA (A7).
- **LLMs and paid services:** no LLM calls and no paid or remote service.
- **Automatic stopping:** no automatic stop of a run for poor quality (ADR-0008).
- **LangGraph:** it is not introduced in Phase 3A if D-3A-02 (b) is chosen. The shared LangGraph graph remains the
  platform target, and A1's node contracts are framework-independent so that A1 joins it without redesign.

### 1.5 Success measures

The criteria are in §6. Every numeric target there is a proposal for the user to decide.

- **Detection quality:** detection precision and recall per flag kind on a labelled synthetic degradation corpus.
- **Consistency:**
  - determinism: same input, configuration and rule version give an identical output;
  - monotonicity: more degradation never gives a better class.
- **Downstream relevance:** the A1 assessment correlates with measured STT error (E7 per-SNR WER) on the same clips.
- **Cost:** measurement time and peak memory within the accepted limits, on recordings up to the 4 h ceiling.

## 2. Measurable vs estimated vs inferred

A1 keeps three kinds of statement apart. The kind travels with every value up to the UI.

| Kind | Meaning | Examples |
| --- | --- | --- |
| **Measured** | Computed exactly from samples or container metadata | Sample rate, channels, duration, codec, peak, RMS, clipped sample count, digital-silence runs, decode gaps |
| **Derived** | Deterministic arithmetic on measured values | Crest factor, clipped ratio, silence ratio, speech ratio (given the speech detector) |
| **Estimate** | A model of the signal that can be wrong in known ways | Noise floor, SNR proxy, active-speech level, effective bandwidth, loudness (EBU R128 is a standard estimate) |
| **Assessment** (A1 output) | A1's judgement from rules over the three kinds above | Flag severity, overall class, suitability, recommendations |

The measured, derived and estimate kinds already exist in the audio service (`Quantity.kind`). The assessment kind is
new and lives only in A1's output.

## 3. Quality dimensions: feasibility triage

**Tier 0** is available today from the Phase 2B measurements and needs no audio-service change. **Tier 1** needs the
proposed speech-aware `measure` task (ADR-0045). "Not in v1" means A1 reports the dimension as *not assessed*, with a
reason; it never silently omits it.

### A. Technical properties

| Dimension | Status | Source |
| --- | --- | --- |
| Sample rate, channels, codec, container, bit depth | Tier 0, measured | `recordings.media_probe` (`sampleRateHz`, `channels`, `codec`, `sampleFormat`, `bitsPerRawSample`, `bitRate`) |
| Duration | Tier 0, measured | Probe, and the canonical `durationMs` |
| Peak, RMS, crest factor | Tier 0 | `original_decoded` and `canonical` records |
| Clipping, saturation | Tier 0 | `clippedSamples`, `clippedRatio`, `clippedRuns`, `longestClippedRunSamples`; `truePeakDbtp`; regions from the 100 ms `peakDbfs` series |
| Dynamic range | Tier 0 (proxy) | `loudnessRangeLu` (EBU R128 LRA) and crest factor. There is no other standard "dynamic range" figure, and A1 uses no other |
| DC offset, channel imbalance or phase problems | Tier 0 | `dcOffset` and `correlationCh{i}Ch{j}` per channel. Useful for stereo phone or meeting captures |
| Effective bandwidth (narrowband or low-bitrate) | Tier 1, estimate | Spectral roll-off of speech frames on the canonical 16 kHz signal, so it can detect band limits below 8 kHz only (for example telephone 3.4 kHz) |

### B. Acoustic quality

| Dimension | Status | Notes |
| --- | --- | --- |
| Silence and quiet periods | Tier 0 | `silenceRatio` and regions from the `rmsDbfs` series |
| Background noise level | Tier 0 (rough) / Tier 1 | Tier 0 has `noiseFloorDbfs` (10th-percentile window RMS; "not an SNR"). Tier 1 measures the level of the non-speech frames |
| SNR proxy | Tier 1, estimate | Active-speech level minus non-speech level, per region and overall. Accuracy is to be measured against the known mixing SNR of the Phase 2B VAD corpus (M0) |
| Dropouts | Tier 0 | Timeline gaps (`timestamp_gap_filled`), `decodeErrors`, and digital-zero runs inside otherwise active audio (Tier 1 gives the frame resolution) |
| Level consistency | Tier 1 | Spread of the active-speech level across blocks; detects a speaker far from the microphone or a gain jump |
| Distortion other than clipping | **Not in v1** | Without a reference signal no reliable detector is available without a model. Reported as *not assessed*. `harmonicDistortion` is already `unavailable: no_reference` |
| Reverberation and echo | **Not in v1** | Blind reverberation estimators (C50, DRR) need ML models such as Brouhaha, which needs PyTorch, or are unreliable. *Not assessed*; candidates are listed in `A1_ALGORITHMS_AND_EVALUATION.md` §3 |

### C. Speech quality

| Dimension | Status | Notes |
| --- | --- | --- |
| Speech presence and proportion | Tier 1 | Silero VAD speech ratio (reuses the pinned model, ADR-0038) |
| Low-volume speech | Tier 1 | Active-speech level per region |
| Speech-to-noise relationship | Tier 1 | The SNR proxy, computed over speech regions only |
| Long pauses, fragmented speech | Tier 1 | Gap and span statistics from the VAD. With the ADR-0038 settings, spans per 30 s window can warn about the known dense-speech deadline limitation (ADR-0041). Candidate flag, D-3A-07 |
| Intelligibility | **Proxy only in v1** | No validated non-intrusive intelligibility model fits without a new dependency. v1 combines the SNR proxy, speech level, bandwidth and clipping, and labels the result an *estimate*. It never claims STOI/PESQ-like scores |
| Overlapping speech | **Excluded: A2's job** | Overlap comes from diarization (`overlapping_speech` uncertainty, A2). A1 does not duplicate it |

### D. Downstream suitability

| Dimension | Status | Notes |
| --- | --- | --- |
| Transcription suitability | Tier 0 coarse, Tier 1 full | Rules over the SNR proxy, speech level, clipping in speech, bandwidth, speech presence and dropouts |
| Diarization suitability | Tier 1 | Speech duration, SNR proxy, level consistency, bandwidth. A1 does not predict speaker count |
| Language-identification risk | Tier 1, reason code only | Very short speech spans and low SNR are known to hurt LID (ADR-0036 evidence). A1 emits a *reason* on transcription suitability and makes no LID judgement |
| "Would enhancement help?" | Recommendation text only | A1 recommends user actions (re-record closer to the microphone, avoid automatic gain, use a lossless format). It never applies enhancement (non-goal) |

## 4. Functional specification

### 4.1 When A1 executes

Recommended (D-3A-03), with the decision in ADR-0044:

1. **After preprocessing succeeds**, the preprocessing flow runs the Tier 1 `measure` step. This is deterministic and
   preprocessing-scoped (ADR-0015, ADR-0045). It is reused when the measurement config hash matches.
2. **As soon as the Tier 0 + Tier 1 measurements exist** for the recording's latest run, A1 (a rule engine in the
   orchestrator) classifies them and writes run-scoped diagnostics.
   - In the current product flow the run is in status `created`, waiting for the user to start transcription.
     **[CHANGE, needs approval]:** A1 runs on a `created` run before transcription is submitted.
   - This gives the user the assessment *before* deciding to transcribe. Nothing is stopped automatically
     (ADR-0008); the user simply chooses.
3. **If the user starts transcription before A1 finishes**, the two continue independently. A2 never waits for A1
   (ADR-0021).
   - Pinning to the preprocessing version, submission, failure, A1-only retry, cancellation and UI wording follow the
     canonical lifecycle in `A1_DESIGN.md` §2.3.1 (L1–L10).
4. **Re-runs** (new runs on the same preprocessing version) re-classify with the current rule version. They reuse the
   measurements and do not re-measure.

The alternative (D-3A-03 option b) is that A1 runs only inside a submitted run, as a stage in parallel with
transcription, which is the ADR-0021 topology. In that case the user sees the assessment only after starting
transcription.

### 4.2 Inputs (A1 receives only these)

- **Per-segment measurements (FR-3.1):** preprocessing VAD is `none` (ADR-0038), so there are no
  `audio_segments` and no per-segment records. A1 meets "per segment" through per-block series (Tier 0: 100 ms; Tier 1:
  the block size) and whole-recording records. Whether that satisfies FR-3.1 is part of D-3A-09.
- The preprocessing version:
  - the `original_decoded` and `canonical` measurement records;
  - the `level-series.json` artefact (100 ms RMS and peak);
  - the timeline (gaps, decode errors);
  - `recordings.media_probe`.
- The speech-aware measurement set (Tier 1) for that preprocessing version: the summary quantities and the
  `speech-series.json` artefact.
- The rule configuration (versioned), which is part of the run's config snapshot.
- **Never:** transcripts, STT or diarization output, uncertainties, or anything written by A2–A7 (AGENT §2.2).

### 4.3 Deterministic assessments

A1 is entirely deterministic in v1: rules over measurements (ADR-0043). There is no ML model in A1 itself.

- **The only ML component** is the existing Silero VAD inside the audio service's `measure` task, used as a
  measurement instrument (a speech/non-speech split), exactly as transcription already uses it.

### 4.4 Flags

- Each flag has:
  - a `kind`;
  - a `severity` (`low | medium | high`; the UI type already uses this);
  - `startMs` / `endMs` on the canonical timeline, or a whole-recording scope;
  - `basis` (the weakest kind among its inputs: measured, derived or estimate);
  - `measurementRefs` (the quantity names and the series indices used);
  - a rule ID.
- **Kinds:**
  - existing design: `noise`, `clipping`, `distortion`, `dropout`, `silence`, `low_level`;
  - **[CHANGE, needs approval]** proposed additions: `low_speech_presence`, `narrowband`, `level_inconsistency`, and
    the candidate `fragmented_speech` (D-3A-07);
  - `distortion` is reserved and not emitted in v1 (*not assessed*).
- **Region flags** come from block series: 100 ms for Tier 0, and the Tier 1 block size set by M0. Adjacent blocks of
  the same kind and severity merge, with a minimum region duration and a merge gap from config.

### 4.5 Combining findings into an overall assessment

The rule engine is ordered and explainable:

1. **Per-flag severity** comes from config thresholds on the relevant quantity.
2. **Coverage:** for each kind and severity, A1 computes the share of *speech time* affected (of total time when
   speech is not assessable).
3. **Overall class.** **[CHANGE, needs approval]:** four classes against the designed `good | degraded | poor`
   (D-3A-04).
   - `insufficient`: no usable speech, i.e. Tier 1 speech presence below a configured floor, or the measurements say
     the canonical audio is effectively silent. Processing still continues if the user starts it (ADR-0008); the UI
     recommends a new recording.
   - `poor`: any high-severity flag whose coverage exceeds a configured share of speech time.
   - `acceptable_with_warnings`: any medium or high flag below that coverage, or any medium flag at all.
   - `good`: otherwise.
   - The exact coverage shares are thresholds calibrated in M6 and approved by the user.
4. **Suitability** for `transcription` and `diarization`: `suitable | limited | unreliable | not_assessable`. Each
   comes from its own rule subset and lists its reason codes (flag IDs and the LID-risk reason).
5. **Recommendations:** fixed, versioned templates keyed by reason code. They are not generated text.
6. **Not assessed:** a list of `{dimension, reason}` entries, for example `distortion: no_reference_free_detector`,
   `reverberation: not_supported_v1`, or `snr: measure_step_failed`.

Fixed rule order and integer-scaled thresholds keep the result deterministic. Each rule is a pure function, so it can
be tested on its own.

### 4.6 Confidence and uncertainty

- **No calibrated probability is claimed.** A1 emits a categorical `confidence` (`high | medium | low`) for the
  overall class, from explicit rules:
  - `low` if any input to a deciding rule is unavailable, if the recording is shorter than a configured minimum, or if
    speech presence is not assessable;
  - `medium` if a deciding rule rests on an *estimate*;
  - `high` if it rests only on measured or derived values.
- Each flag carries its `basis`, so the UI can show "estimated" next to estimates.
- Measurement uncertainty is documented per estimator from the M0 and M6 evidence, for example "SNR proxy: mean
  absolute error X dB on the synthetic corpus". It appears in docs and tooltips, not as a per-value error bar.

### 4.7 Persistence

The details are in `A1_DESIGN.md` §5.

- **Measurements** (objective, preprocessing-scoped, immutable): the existing `audio_measurements` plus the new
  Tier 1 measurement set.
- **Diagnostics** (run-scoped, written only by A1): `audio_diagnostics` (one row per run per rule version run) and
  `audio_diagnostic_flags`.

### 4.8 Frontend

- **Recording detail:**
  - The existing "Audio quality" card and the "Audio quality analysis" step become live. The card shows the overall
    class, its confidence, the two suitability values, the top reasons and recommendations, and the "not assessed"
    list.
  - The existing `diagnostics` timeline track shows flag regions, using the `--diag-*` tokens that ADR-0030 keeps
    separate from the uncertainty tokens.
- **Copy says what kind of statement it is:** "Measured", "Estimated" or "Assessment by the Audio Quality Agent". It
  never says "transcript is wrong".
- **`insufficient`** shows a clear call to action ("This recording contains little or no detectable speech; consider
  uploading a new recording"). Start transcription stays available (ADR-0008).
- **Not available yet:** a diagnostics state that is still pending, failed or not assessable is shown honestly, in the
  same style as the existing Phase 2A states.
- **Accessibility:** axe with no serious or critical violations (ADR-0029). Severity is never conveyed by colour alone.

### 4.9 Downstream communication

**[CHANGE, needs approval: D-3A-05, ADR-0046, OD-54].** This amends FR-3.5, ADR-0019, ADR-0021, AGENT §1–§4 and
TESTING §3.

- **Contracts:** both are zod schemas in `packages/contracts`, versioned and framework-independent (`A1_DESIGN.md` §4).
  They are the only A1 shapes other components may read.
  - `AudioQualitySummary` v1: the overall class, confidence, suitability, flag counts, affected speech share, rule
    version and diagnostics ID.
  - `AudioQualityContext`: the summary plus each flag's kind, severity and time range.
- **Access:** the read-only `AudioQualityReader` port, keyed by run and preprocessing version. It returns the context,
  or `unavailable | pending | failed`.

| Consumer | Availability (may read) | Execution dependency (waits) | Behavioural coupling in Phase 3A |
| --- | --- | --- | --- |
| A2 Transcription | Yes: quality constraints and affected time ranges | **No**; it proceeds without the context | **None.** A2 code and output are unchanged. Any future use needs its own ADR and the E7-style accuracy gate |
| A3 Context Intelligence | Yes: reliability context for transcript-derived information | **No** | None (A3 is not implemented). In 3B it may attach references only, for example "claim span overlaps a high-severity noise flag" |
| A6 Reporting | Yes | Yes (the existing A1 + A5 join) | *Audio limitations* section (mandatory when flags exist, ADR-0008) and caveats |
| A7 QA | Yes | Through A6 | Consistency of report statements with the summary; diagnostics/uncertainty conflation (FR-10.2) |

- **Guard rails** (FR-3.3 / FR-9.3 unchanged):
  - A2 never derives, creates, changes or suppresses uncertainty from A1 data.
  - A1 never reads transcription data.
  - Consumers store only a `diagnosticsId` reference and never copy flags as their own findings.
- **No automatic blocking, skipping, pausing or enhancement** (ADR-0008 unchanged). "Require user intervention" means
  that the user sees `insufficient` and recommendations before choosing to start transcription.

## 5. Error handling

- **`measure` task failure:**
  - It retries within the A1 job's BullMQ attempts and the measurement set's attempt cap
    (`AUDIO_QUALITY_MAX_ATTEMPTS`), as built (A1_DESIGN §9 note 1).
  - After the last attempt it is recorded on the measurement set as `failed` with a code.
  - A1 then runs on Tier 0 only, listing the Tier 1 dimensions as *not assessed* (`measure_step_failed`), with
    confidence `low`.
  - Preprocessing itself stays `succeeded`: its accepted behaviour is unchanged.
- **A1 rule-engine failure** (a bug, or invalid stored input):
  - The `audio_quality` stage is marked `failed` with a code.
  - Transcription is unaffected (ADR-0021: an A1 failure blocks only A6).
  - A user retry re-runs A1 only (lifecycle L6).
- **Cancellation of the run** stops a pending or running A1 stage and keeps completed diagnostics (L5). It does not
  cancel the preprocessing-scoped `measure` task. Cancelling it through processing cancel (L8, via the existing
  `DELETE /v1/tasks/{id}` path) is **Proposed, not implemented** (A1_DESIGN §9 note 5).
- **Undecodable audio** fails at probe or preprocess, which is unchanged. A1 never sees it.

## 6. Proposed acceptance criteria

Each item states whether its threshold needs empirical evidence (E) and the user's approval (U).

| # | Criterion | E/U |
| --- | --- | --- |
| AC-1 | Every successfully preprocessed recording gets a diagnostics record: an overall class, confidence, suitability, flags and the not-assessed list. A missing or failed record is shown honestly | — |
| AC-2 | No A1 path reads transcription tables, and no A1 path writes any non-A1 table. No other component writes diagnostics tables. Other components read A1 data only through `AudioQualityReader` (ADR-0046). Transcription output is identical with the A1 context present, absent or failed. Repository and import-graph tests (TESTING §3, amended if ADR-0046 is approved) | — |
| AC-3 | Transcription and diarization outputs, timings and the 2B/2C suites are unchanged with A1 enabled (regression suites; E2E diff of a reference run) | — |
| AC-4 | Determinism: identical diagnostics for the same measurements, configuration and rule version; identical measurement sets for the same canonical audio and measurement config (in-container). Silero with 2 threads (ADR-0041) has not yet been shown to be deterministic. M0 checks it; if it is not, Tier 1 values are compared within a stated tolerance instead of byte for byte | E (Tier 1) |
| AC-5 | Detection: per flag kind, precision ≥ P and recall ≥ R on the labelled synthetic degradation set, per language (en, hi, Hinglish) | P = R = 0.9 at any severity (ADR-0048) |
| AC-6 | False positives: clean synthetic speech is classed `good` in ≥ X % of clips; no high-severity flag on clean clips | X = 90 % (ADR-0048) |
| AC-7 | Monotonicity: for each controlled degradation sweep, the class never improves as degradation increases | — |
| AC-8 | SNR proxy: mean absolute error against the known mixing SNR (the ground truth; methodology in `A1_ALGORITHMS_AND_EVALUATION.md` §6.1) ≤ Y dB at 20 / 10 / 5 dB. WADA-SNR is a baseline, not a reference | Y = 2.0 dB (ADR-0048) |
| AC-9 | Downstream relevance: a positive rank correlation between degradation and E7 WER on the C3 test clips, reported per language (a target value, or "report only", is the user's choice) | Positive correlation; values reported (ADR-0048) |
| AC-10 | Resources: the measure task stays within 768 MB with no memory growth on a generated 4 h recording; RTF ≤ Z at 2 CPUs; no change to other services' limits | Z = 0.05 (ADR-0048) |
| AC-11 | `insufficient` on silent, noise-only and tone-only fixtures; `not_assessable` handled for very short audio | — |
| AC-12 | API: `GET /api/v1/workspaces/{workspaceId}/runs/{runId}/audio-diagnostics` (API §4) returns 404 for another workspace (SEC-2); no content in logs (SEC-9); deleted with the recording (SEC-6) | — |
| AC-13 | UI: the card, step and timeline track render every state; axe has no serious or critical violations; the diagnostics and uncertainty visual languages are distinct | — |
| AC-14 | Browser E2E on the real stack with synthetic clips from each category (clean, noisy, low-level, clipped, silent, narrowband, multi-speaker; en/hi/Hinglish) | — |

The proposed values for P, R, X, Y and Z are produced in M0/M6 from evidence. **They are not set here** (no invented
thresholds).

**Synthetic-only limitation.** AC-5, AC-6, AC-8 and AC-9 are measured on locally generated synthetic data: macOS TTS
speech with NumPy noise and degradations. Passing them shows behaviour *on that corpus* only. **It is not evidence of
real-world accuracy**, and no Phase 3A document or UI text may claim it. Real-speech evaluation needs a separately
approved corpus download (D-3A-13). The thresholds were approved on this synthetic evidence (ADR-0048, rule version
`a1-rules-1.0`). Assessments made earlier with the provisional rules keep their *provisional* label. Docs label
results *synthetic*, and a real-speech evaluation may produce a new rule version.
