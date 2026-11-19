# Evidence, analytics and provenance

## Provenance (every assertion)
- Each report assertion shows a provenance badge: **Recorded** (said in the audio), **External** (from research evidence) or **Inferred** (AI interpretation), with token colour, icon and text.
- Recorded → links to transcript span(s): seeks the player and highlights the segment, showing speaker and timestamp.
- External → links to evidence: source title, publisher, retrieval date, verbatim quoted passage and a link to the stored snapshot. Snippet-only sources are visibly marked and never shown as supporting a verdict.
- Inferred → shows its basis (the assertions it relies on) and its origin.

## Confidence and uncertainty
- **Never invent or derive numerical confidence scores in the UI.**
- Show a number only when the underlying provider or model supplied it, and label its origin, for example "STT provider confidence: 0.82" or "Model-estimated confidence (Reporting Agent): 0.7". Model self-estimates are labelled as estimates, not calibrated probabilities.
- Without a supplied value, show qualitative uncertainty from the data model ("Low confidence segment", "Inaudible", "Overlapping speech", "Unverifiable", "Partially supported").
- Do not convert qualitative states into numbers or bars that imply precision.

## Verdicts and claims
- Verdict chips show text plus icon plus colour (taxonomy OD-30 is Proposed; render from data). Claims show the verbatim quotation separately from any paraphrase (paraphrase labelled Inferred).

## Report sections
- *Audio limitations* (from audio diagnostics) and *Transcription uncertainty* are separate sections with separate headings and wording.
- The report states which transcript version it was generated from, and its language (English default, Hindi option).

## Analytics
- Prefer simple, honest charts (speaker talk time, verdict distribution, diagnostics over time) with labelled axes, units and an accessible table alternative. The charting library is OD-36 (Open): no chart dependency without approval.
- Never chart inferred values as if they were measured.
