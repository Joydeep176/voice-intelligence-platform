## Common subset: the 60 test clips every engine transcribed (percent)

Same clips for every engine (clean and 10 dB, first 10 sentences per language, Hinglish 5 per kind), so the rows are directly comparable. Cells hold few words: read differences of a few points as noise.

### WER

| Engine | Language | clean | 10 dB | clips/cell |
| --- | --- | --- | --- | --- |
| faster-whisper-small-int8 | english | 3.1 | 10.0 | 10 |
| faster-whisper-small-int8 | hindi | 35.0 | 39.0 | 10 |
| faster-whisper-small-int8 | hinglish | 82.2 | 85.1 | 10 |
| faster-whisper-small-int8 | hinglish-hd | 41.5 | 46.3 | 5 |
| faster-whisper-small-int8 | hinglish-hr | 110.0 | 111.7 | 5 |
| faster-whisper-medium-int8 | english | 2.3 | 2.3 | 10 |
| faster-whisper-medium-int8 | hindi | 22.0 | 30.0 | 10 |
| faster-whisper-medium-int8 | hinglish | 77.2 | 78.2 | 10 |
| faster-whisper-medium-int8 | hinglish-hd | 36.6 | 41.5 | 5 |
| faster-whisper-medium-int8 | hinglish-hr | 105.0 | 103.3 | 5 |
| whisper.cpp-small-q5_1 | english | 3.1 | 9.2 | 10 |
| whisper.cpp-small-q5_1 | hindi | 37.0 | 41.0 | 10 |
| whisper.cpp-small-q5_1 | hinglish | 84.2 | 92.1 | 10 |
| whisper.cpp-small-q5_1 | hinglish-hd | 46.3 | 48.8 | 5 |
| whisper.cpp-small-q5_1 | hinglish-hr | 110.0 | 121.7 | 5 |
| whisper.cpp-medium-q5_0 | english | 1.5 | 3.1 | 10 |
| whisper.cpp-medium-q5_0 | hindi | 30.0 | 30.0 | 10 |
| whisper.cpp-medium-q5_0 | hinglish | 81.2 | 82.2 | 10 |
| whisper.cpp-medium-q5_0 | hinglish-hd | 39.0 | 41.5 | 5 |
| whisper.cpp-medium-q5_0 | hinglish-hr | 110.0 | 110.0 | 5 |
| sherpa-onnx-whisper-small-int8 | english | 3.1 | 10.0 | 10 |
| sherpa-onnx-whisper-small-int8 | hindi | 33.0 | 35.0 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish | 80.2 | 85.1 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish-hd | 41.5 | 48.8 | 5 |
| sherpa-onnx-whisper-small-int8 | hinglish-hr | 106.7 | 110.0 | 5 |
| sherpa-onnx-whisper-medium-int8 | english | 1.5 | 6.2 | 10 |
| sherpa-onnx-whisper-medium-int8 | hindi | 28.0 | 31.0 | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish | 76.2 | 86.1 | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hd | 36.6 | 43.9 | 5 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hr | 103.3 | 115.0 | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | english | 21.5 | 25.4 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hindi | 21.0 | 33.0 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish | 82.2 | 96.0 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hd | 41.5 | 75.6 | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hr | 110.0 | 110.0 | 5 |

### CER

| Engine | Language | clean | 10 dB | clips/cell |
| --- | --- | --- | --- | --- |
| faster-whisper-small-int8 | english | 1.3 | 4.9 | 10 |
| faster-whisper-small-int8 | hindi | 17.3 | 19.5 | 10 |
| faster-whisper-small-int8 | hinglish | 86.8 | 89.2 | 10 |
| faster-whisper-small-int8 | hinglish-hd | 46.3 | 50.0 | 5 |
| faster-whisper-small-int8 | hinglish-hr | 113.4 | 115.0 | 5 |
| faster-whisper-medium-int8 | english | 1.1 | 1.6 | 10 |
| faster-whisper-medium-int8 | hindi | 10.7 | 13.7 | 10 |
| faster-whisper-medium-int8 | hinglish | 88.7 | 87.0 | 10 |
| faster-whisper-medium-int8 | hinglish-hd | 45.1 | 46.3 | 5 |
| faster-whisper-medium-int8 | hinglish-hr | 117.5 | 113.8 | 5 |
| whisper.cpp-small-q5_1 | english | 1.3 | 4.0 | 10 |
| whisper.cpp-small-q5_1 | hindi | 16.8 | 20.6 | 10 |
| whisper.cpp-small-q5_1 | hinglish | 89.7 | 95.6 | 10 |
| whisper.cpp-small-q5_1 | hinglish-hd | 49.4 | 54.3 | 5 |
| whisper.cpp-small-q5_1 | hinglish-hr | 116.3 | 122.8 | 5 |
| whisper.cpp-medium-q5_0 | english | 0.9 | 1.8 | 10 |
| whisper.cpp-medium-q5_0 | hindi | 12.9 | 13.5 | 10 |
| whisper.cpp-medium-q5_0 | hinglish | 87.0 | 83.8 | 10 |
| whisper.cpp-medium-q5_0 | hinglish-hd | 45.1 | 46.9 | 5 |
| whisper.cpp-medium-q5_0 | hinglish-hr | 114.6 | 108.1 | 5 |
| sherpa-onnx-whisper-small-int8 | english | 1.3 | 3.6 | 10 |
| sherpa-onnx-whisper-small-int8 | hindi | 16.5 | 18.4 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish | 88.5 | 88.0 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish-hd | 48.8 | 53.7 | 5 |
| sherpa-onnx-whisper-small-int8 | hinglish-hr | 114.6 | 110.6 | 5 |
| sherpa-onnx-whisper-medium-int8 | english | 0.9 | 4.1 | 10 |
| sherpa-onnx-whisper-medium-int8 | hindi | 13.2 | 14.0 | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish | 86.5 | 85.5 | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hd | 43.8 | 46.3 | 5 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hr | 114.6 | 111.4 | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | english | 6.5 | 8.6 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hindi | 8.8 | 15.4 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish | 87.0 | 98.0 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hd | 45.1 | 72.2 | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hr | 114.6 | 115.0 | 5 |

## STT accuracy (test split, percent; WER = word, CER = code point; lower is better)

### WER

| Engine | Language | clean | 20 dB | 10 dB | 5 dB | clips/cell |
| --- | --- | --- | --- | --- | --- | --- |
| faster-whisper-small-int8 | english | 3.9 | 4.3 | 12.2 | 12.2 | 20 |
| faster-whisper-small-int8 | hindi | 49.3 | 43.5 | 53.6 | 58.9 | 20 |
| faster-whisper-small-int8 | hinglish | 76.8 | 77.8 | 80.2 | 82.1 | 20 |
| faster-whisper-small-int8 | hinglish-hd | 40.0 | 41.1 | 46.7 | 53.3 | 10 |
| faster-whisper-small-int8 | hinglish-hr | 105.1 | 106.0 | 106.0 | 104.3 | 10 |
| faster-whisper-medium-int8 | english | 2.3 | n/a | 2.3 | n/a | 10 |
| faster-whisper-medium-int8 | hindi | 22.0 | n/a | 30.0 | n/a | 10 |
| faster-whisper-medium-int8 | hinglish | 77.2 | n/a | 78.2 | n/a | 10 |
| faster-whisper-medium-int8 | hinglish-hd | 36.6 | n/a | 41.5 | n/a | 5 |
| faster-whisper-medium-int8 | hinglish-hr | 105.0 | n/a | 103.3 | n/a | 5 |
| whisper.cpp-small-q5_1 | english | 3.1 | n/a | 9.2 | n/a | 10 |
| whisper.cpp-small-q5_1 | hindi | 37.0 | n/a | 41.0 | n/a | 10 |
| whisper.cpp-small-q5_1 | hinglish | 84.2 | n/a | 92.1 | n/a | 10 |
| whisper.cpp-small-q5_1 | hinglish-hd | 46.3 | n/a | 48.8 | n/a | 5 |
| whisper.cpp-small-q5_1 | hinglish-hr | 110.0 | n/a | 121.7 | n/a | 5 |
| whisper.cpp-medium-q5_0 | english | 1.5 | n/a | 3.1 | n/a | 10 |
| whisper.cpp-medium-q5_0 | hindi | 30.0 | n/a | 30.0 | n/a | 10 |
| whisper.cpp-medium-q5_0 | hinglish | 81.2 | n/a | 82.2 | n/a | 10 |
| whisper.cpp-medium-q5_0 | hinglish-hd | 39.0 | n/a | 41.5 | n/a | 5 |
| whisper.cpp-medium-q5_0 | hinglish-hr | 110.0 | n/a | 110.0 | n/a | 5 |
| sherpa-onnx-whisper-small-int8 | english | 3.9 | 4.7 | 11.8 | 15.4 | 20 |
| sherpa-onnx-whisper-small-int8 | hindi | 43.0 | 47.8 | 50.7 | 53.6 | 20 |
| sherpa-onnx-whisper-small-int8 | hinglish | 79.2 | 79.7 | 86.0 | 87.9 | 20 |
| sherpa-onnx-whisper-small-int8 | hinglish-hd | 47.8 | 48.9 | 58.9 | 63.3 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish-hr | 103.4 | 103.4 | 106.8 | 106.8 | 10 |
| sherpa-onnx-whisper-medium-int8 | english | 1.5 | n/a | 6.2 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hindi | 28.0 | n/a | 31.0 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish | 76.2 | n/a | 86.1 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hd | 36.6 | n/a | 43.9 | n/a | 5 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hr | 103.3 | n/a | 115.0 | n/a | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | english | 24.0 | 26.4 | 27.6 | 33.9 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hindi | 27.1 | 38.6 | 45.4 | 55.1 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish | 75.8 | 80.7 | 87.4 | 87.0 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hd | 35.6 | 46.7 | 62.2 | 61.1 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hr | 106.8 | 106.8 | 106.8 | 106.8 | 10 |

### CER

| Engine | Language | clean | 20 dB | 10 dB | 5 dB | clips/cell |
| --- | --- | --- | --- | --- | --- | --- |
| faster-whisper-small-int8 | english | 2.1 | 2.2 | 6.2 | 7.1 | 20 |
| faster-whisper-small-int8 | hindi | 28.0 | 22.0 | 29.8 | 39.4 | 20 |
| faster-whisper-small-int8 | hinglish | 82.6 | 82.9 | 84.1 | 85.4 | 20 |
| faster-whisper-small-int8 | hinglish-hd | 48.5 | 48.8 | 50.9 | 55.2 | 10 |
| faster-whisper-small-int8 | hinglish-hr | 106.5 | 106.7 | 107.3 | 106.5 | 10 |
| faster-whisper-medium-int8 | english | 1.1 | n/a | 1.6 | n/a | 10 |
| faster-whisper-medium-int8 | hindi | 10.7 | n/a | 13.7 | n/a | 10 |
| faster-whisper-medium-int8 | hinglish | 88.7 | n/a | 87.0 | n/a | 10 |
| faster-whisper-medium-int8 | hinglish-hd | 45.1 | n/a | 46.3 | n/a | 5 |
| faster-whisper-medium-int8 | hinglish-hr | 117.5 | n/a | 113.8 | n/a | 5 |
| whisper.cpp-small-q5_1 | english | 1.3 | n/a | 4.0 | n/a | 10 |
| whisper.cpp-small-q5_1 | hindi | 16.8 | n/a | 20.6 | n/a | 10 |
| whisper.cpp-small-q5_1 | hinglish | 89.7 | n/a | 95.6 | n/a | 10 |
| whisper.cpp-small-q5_1 | hinglish-hd | 49.4 | n/a | 54.3 | n/a | 5 |
| whisper.cpp-small-q5_1 | hinglish-hr | 116.3 | n/a | 122.8 | n/a | 5 |
| whisper.cpp-medium-q5_0 | english | 0.9 | n/a | 1.8 | n/a | 10 |
| whisper.cpp-medium-q5_0 | hindi | 12.9 | n/a | 13.5 | n/a | 10 |
| whisper.cpp-medium-q5_0 | hinglish | 87.0 | n/a | 83.8 | n/a | 10 |
| whisper.cpp-medium-q5_0 | hinglish-hd | 45.1 | n/a | 46.9 | n/a | 5 |
| whisper.cpp-medium-q5_0 | hinglish-hr | 114.6 | n/a | 108.1 | n/a | 5 |
| sherpa-onnx-whisper-small-int8 | english | 2.1 | 2.5 | 5.6 | 9.3 | 20 |
| sherpa-onnx-whisper-small-int8 | hindi | 20.2 | 24.4 | 31.0 | 31.4 | 20 |
| sherpa-onnx-whisper-small-int8 | hinglish | 84.4 | 83.8 | 87.1 | 88.3 | 20 |
| sherpa-onnx-whisper-small-int8 | hinglish-hd | 52.0 | 50.6 | 61.3 | 64.0 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish-hr | 107.1 | 107.1 | 105.1 | 105.3 | 10 |
| sherpa-onnx-whisper-medium-int8 | english | 0.9 | n/a | 4.1 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hindi | 13.2 | n/a | 14.0 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish | 86.5 | n/a | 85.5 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hd | 43.8 | n/a | 46.3 | n/a | 5 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hr | 114.6 | n/a | 111.4 | n/a | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | english | 7.9 | 8.3 | 10.9 | 17.4 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hindi | 10.1 | 21.6 | 31.4 | 41.2 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish | 81.1 | 83.8 | 88.0 | 89.0 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hd | 43.6 | 50.6 | 60.2 | 62.8 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hr | 107.3 | 107.1 | 107.5 | 107.3 | 10 |

### Language identification (test split, auto-detect, all SNRs pooled)

| Engine | English as en | Hindi as hi | Hinglish clips: detected codes |
| --- | --- | --- | --- |
| faster-whisper-small-int8 | 100.0% | 88.8% | {'hi': 72, 'ur': 7, 'de': 1} |
| faster-whisper-medium-int8 | 100.0% | 100.0% | {'hi': 19, 'nn': 1} |
| whisper.cpp-small-q5_1 | 100.0% | 100.0% | {'hi': 17, 'ur': 3} |
| whisper.cpp-medium-q5_0 | 100.0% | 100.0% | {'hi': 19, 'en': 1} |
| sherpa-onnx-whisper-small-int8 | 100.0% | 93.8% | {'hi': 73, 'ur': 6, 'de': 1} |
| sherpa-onnx-whisper-medium-int8 | 100.0% | 100.0% | {'hi': 18, 'en': 1, 'ur': 1} |
| sherpa-onnx-omnilingual-300M-ctc-int8 | n/a (no language reported) | n/a (no language reported) | {'none': 80} |

### Determinism (two runs, same settings, first 40 clips)

| Engine | Identical text and language |
| --- | --- |
| faster-whisper-small-int8 | 40 of 40 |
| faster-whisper-medium-int8 | 12 of 12 |
| whisper.cpp-small-q5_1 | 12 of 12 |
| whisper.cpp-medium-q5_0 | 20 of 20 |
| sherpa-onnx-whisper-small-int8 | 40 of 40 |
| sherpa-onnx-whisper-medium-int8 | 12 of 12 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | 40 of 40 |

## STT resources (1 CPU, container; limits in the README)

| Engine | Disk MiB | Load s | RTF (median of 3) | CPU s per audio hour | Anon after load MiB | memory.peak MiB | Anon max MiB | Long file: wall / RTF | Long file anon first / last third MiB | 512 MiB container |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| faster-whisper-small-int8 | 464 | 2.1 | 1.049 | 3763 | 304 | 1885 | 1282 | 7 min: 765 s / 1.910 | 1047 / 1282 | OOM-killed |
| faster-whisper-medium-int8 | 1460 | 7.3 | 3.055 | 10976 | 870 | 3072 | 2799 | 2 min: 1008 s / 7.332 | 1593 / 2716 | OOM-killed |
| whisper.cpp-small-q5_1 | 181 | 0.6 | 2.837 | 10127 | 303 | 803 | 607 | 2 min: 621 s / 4.191 | 498 / 607 | completed (peak 512 MiB) |
| whisper.cpp-medium-q5_0 | 514 | 1.8 | 7.530 | 26972 | 756 | 1486 | 950 | 1 min: 475 s / 8.521 | 887 / 950 | OOM-killed |
| sherpa-onnx-whisper-small-int8 | 358 | 2.0 | 0.990 | 3531 | 488 | 1713 | 1334 | 7 min: 646 s / 1.523 | 1328 / 1334 | OOM-killed |
| sherpa-onnx-whisper-medium-int8 | 902 | 6.6 | 4.232 | 15122 | 1224 | 3072 | 2992 | 2 min: 735 s / 7.409 | 2981 / 2992 | OOM-killed |
| sherpa-onnx-omnilingual-300M-ctc-int8 | 349 | 2.2 | 1.308 | 4674 | 541 | 1733 | 1364 | 5 min: 417 s / 1.300 | 1364 / 1364 | OOM-killed |

## Diarization (test split; 250 ms collar; overlaps scored; percent)

### DER by speaker count, dev-tuned clustering threshold

| Candidate | Speakers | Conversations | DER | Missed | False alarm | Confusion | Speaker count exact | Mean detected |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| campplus | 2 | 3 | 14.7 | 0.0 | 0.4 | 14.3 | 1/3 | 4.0 |
| campplus | 3 | 3 | 21.4 | 0.6 | 0.4 | 20.4 | 1/3 | 6.0 |
| campplus | 4 | 3 | 6.1 | 0.6 | 0.7 | 4.8 | 1/3 | 7.0 |
| wespeaker | 2 | 3 | 14.9 | 0.0 | 0.2 | 14.6 | 2/3 | 2.7 |
| wespeaker | 3 | 3 | 18.2 | 0.6 | 0.4 | 17.2 | 1/3 | 5.0 |
| wespeaker | 4 | 3 | 9.9 | 0.6 | 0.7 | 8.5 | 1/3 | 5.0 |

### DER by speaker count, oracle speaker count

| Candidate | Speakers | Conversations | DER | Missed | False alarm | Confusion | Speaker count exact | Mean detected |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| campplus | 2 | 2 | 3.1 | 0.0 | 0.3 | 2.8 | 2/2 | 2.0 |
| campplus | 3 | 2 | 2.8 | 1.5 | 0.1 | 1.2 | 2/2 | 3.0 |
| campplus | 4 | 2 | 3.1 | 0.7 | 1.8 | 0.6 | 2/2 | 4.0 |
| wespeaker | 2 | 2 | 5.1 | 0.0 | 0.3 | 4.7 | 2/2 | 2.0 |
| wespeaker | 3 | 2 | 21.4 | 1.5 | 0.1 | 19.8 | 1/2 | 2.5 |
| wespeaker | 4 | 2 | 29.7 | 0.7 | 1.8 | 27.2 | 0/2 | 3.0 |

### Diarization resources (1 CPU)

| Candidate | Disk MiB | Load s | RTF (median of 3, 5 min file) | CPU s per audio hour | Long file: wall / RTF | Long file DER | Long file anon max MiB | memory.peak MiB | 512 MiB container |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| campplus | 34 | 0.4 | 1.140 | 4079 | 60 min: 4470 s / 1.242 | 25.2 | 423 | 1684 | completed (peak 277 MiB) |
| wespeaker | 31 | 0.2 | 5.375 | 19138 | 60 min: 21388 s / 5.941 | 17.1 | 401 | 1042 | completed (peak 256 MiB) |

### Script of Hinglish output (clean, common clips): share of Devanagari among letters

| Engine | Devanagari-mixed Hinglish (hd) | Romanised Hinglish (hr) |
| --- | --- | --- |
| faster-whisper-small-int8 | 100% (reference 54%) | 80% (reference 0%) |
| faster-whisper-medium-int8 | 100% (reference 54%) | 100% (reference 0%) |
| whisper.cpp-small-q5_1 | 100% (reference 54%) | 80% (reference 0%) |
| whisper.cpp-medium-q5_0 | 100% (reference 54%) | 100% (reference 0%) |
| sherpa-onnx-whisper-small-int8 | 99% (reference 54%) | 100% (reference 0%) |
| sherpa-onnx-whisper-medium-int8 | 100% (reference 54%) | 100% (reference 0%) |
| sherpa-onnx-omnilingual-300M-ctc-int8 | 99% (reference 54%) | 95% (reference 0%) |

### Code-switch examples (synthetic text, clean, first clips of each Hinglish kind)

- `fw-small` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रेपोट कल तक इमेल कर दीजे
- `fw-small` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेज़न्तेशन में तीन स्लाइप्स और जोरनी होंगी
- `fw-small` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीٹिंके लिए प्यर ख्लोएस खर्मल पी सहेसिं पश्चमी अफरीकी रेंदेने वियन लियोनी देना
- `fw-small` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोडा मुष्किल है लेकिन त्रीकान चाहिये

- `fw-medium` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रिपोर्ट कल तक इमेल कर दिजी
- `fw-medium` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेसंटेशन में तीन स्लाइड्स और जोनी होंगी।
- `fw-medium` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीटिंग के लिए प्यर्ट्लोईस्थर्मल्प्पी सहिसिंग पर्ष्चमी अफ्रीकी रेंडिनिवियन लियोनी देना
- `fw-medium` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोड़ा मुश्किल है लेकिन ट्राइकान चाहिये

- `cpp-small` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रिपोट कल तक ये मेल कर दीजे.
- `cpp-small` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रज्द्टेशन में तींश श़्ाएप्स और जोर्नी होंगी.
- `cpp-small` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीٹिंके लिए प्यर ख्लोएस खर्मल पी सहेसिंग पश्च्च्टिमी अफ्रीकी रेंदेने वियन लियोनी देना
- `cpp-small` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोडा मुष्किल है लेकिन त्रीकान चाहिये

- `cpp-medium` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रिपोट कल तक इमेल कर दिजिए
- `cpp-medium` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेसंटेशन में तीन स्लाइज्ड और जोणी होंगी।
- `cpp-medium` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीटिंग के लिए पियर ख्लोइस तरमल पी सहिसिंग पढ़श्चमी अफ्रीकी रैंडिनवियन लियोनी देना
- `cpp-medium` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोड़ा मुषकिल है लेकिन ट्राइकान चाहिए

- `sherpa-small` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रेपोट कल तक एमेल कर दीजे.
- `sherpa-small` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेज़न्तेशन में तीं स्लाइप्स और जोरनी होंगी.
- `sherpa-small` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबाकी मीٹिंके लिए प्यर ख्लोएस खर्मल प्यश्यहसिं पश्च्च्मी अफ्रीकी रेंदेने वियन लियोनी द
- `sherpa-small` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोडा मुष्किल है लेकिन त्रीकान चाहिये

- `sherpa-medium` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रिपोट कल तक इमेल कर दिजि
- `sherpa-medium` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेसंटेशन में तीन स्लाइज़् और जोनी होंगी
- `sherpa-medium` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीटिंग के लिए प्यर्ट्लोईस्त्रमल्प्पी सहिसिंग पर्ष्चमी अफ्रीकी रंडिनिवियन लियो
- `sherpa-medium` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोड़ा मुषकिल है लेकिन ट्राइकान चाहिये

- `omni-300m` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: कृतિयार रिपોर્ट कल तक एमेल करदीજिए
- `omni-300m` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेजेंटेशन में तीन स्लाइबस और जोर्नी होंगी
- `omni-300m` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीटिंग के लिए पिर क्लोएस्थर्मल पी सहेसिंग पश्चिमी अफ्रीकी रेंडनेवियन लियोनी देना
- `omni-300m` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि यह प्लैन थोड़ा मुश्किल है लेकिन ट्रायकान चाहिए

