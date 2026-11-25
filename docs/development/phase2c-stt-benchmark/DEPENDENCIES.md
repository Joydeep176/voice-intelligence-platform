# Phase 2C C3 dependencies and model provenance (STT and diarization benchmark)

Benchmark-only. The Python packages live in the optional dependency groups `stt-benchmark` and
`diarization-benchmark` of `services/audio/pyproject.toml` (`dependencies` is unchanged), are installed only by the
Dockerfile stage `phase2c-benchmark` (via `build-phase2c-benchmark`), and are **not** in the `runtime` or `test` images
(checked by `run.py check-runtime`, result in README). Nothing here selects a provider: OD-02b and OD-03b are the user's
decision (ADR-0012).

Checked on 2026-11-22 from PyPI JSON metadata, the GitHub API, the Hugging Face API and the licence files at the exact
tags, **before** `uv add --group`. The plan wording "verify the licence file at the exact release" is applied to code;
for model weights the licence is the one the hosting card or repository states (the weights file itself carries none).

## Packages (all Linux aarch64 cp312 wheels exist; macOS arm64 wheels exist for every compiled one)

| Package | Version | Released | Licence (verified at) | Wheel used in the image (SHA-256) | Role |
| --- | --- | --- | --- | --- | --- |
| faster-whisper | 1.2.1 | 2025-10-31 (latest; repo pushed 2026-11-12) | MIT (`LICENSE` at tag v1.2.1) | `faster_whisper-1.2.1-py3-none-any.whl`, 1,118,909 B, `79a66ad50688c0b794dd501dc340a736992a6342f7f95e5811be60b5224a26a7` | Whisper via CTranslate2 |
| ctranslate2 | 4.9.0 | 2026-11-10 | MIT (`LICENSE` at tag v4.9.0) | `ctranslate2-4.9.0-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl`, 19,087,256 B, `a2488042f823647050f1e55bb598da8326e14a691a14661f555624b3b2e51fac` | inference engine |
| av (PyAV) | 19.0.2 | 2026-10-21 | BSD-3-Clause (wrapper) | `av-19.0.2-cp312-abi3-manylinux_2_28_aarch64.whl`, 32,683,287 B, `04c8e412642c652cb2b1997a9cb2114546ee7d894600c631f4be8ceb26a0d0d2` | **hard dependency of faster-whisper**, not used by the benchmark (arrays are passed) |
| tokenizers | 0.23.3 | 2026-10-09 | Apache-2.0 (upstream) | `tokenizers-0.23.3-cp310-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64.whl`, 3,519,944 B | faster-whisper dependency |
| huggingface-hub (+ hf-xet 1.8.0, httpx2 2.16.2, httpcore2, requests, urllib3, charset-normalizer, truststore, tqdm, pyyaml, filelock, fsspec, platformdirs) | 2.4.0 | 2026-10-29 | Apache-2.0 | `huggingface_hub-2.4.0-py3-none-any.whl`, 857,021 B | faster-whisper dependency; the benchmark never calls it (`local_files_only`, `HF_HUB_OFFLINE=1`, `--network none`) |
| onnxruntime | 1.32.0 (already locked by the Phase 2B `vad-benchmark` group) | 2026-11-13 | MIT | see Phase 2B DEPENDENCIES.md | faster-whisper dependency (its bundled Silero VAD, not used here); telemetry note in Phase 2B applies |
| pywhispercpp | 1.5.1 | 2026-08-22 (repo pushed 2026-08-22) | MIT (`LICENSE` at tag v1.5.1); bundles whisper.cpp (MIT, ggml-org, latest release v1.9.5 2026-10-06) | `pywhispercpp-1.5.1-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl`, 4,179,842 B, `2f28d7543173082c9d953314ce752588d87a1a2f59a7da440422530480cb4b6a` | Python binding of whisper.cpp |
| sherpa-onnx | 2.0.2 | 2026-11-19 | Apache-2.0 (`LICENSE` at tag v2.0.2; PyPI: Apache licensed) | `sherpa_onnx-2.0.2-cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.whl`, 4,400,703 B, `c54caa5c3ef56c630946382a8effbad87bc61a9e04378b667c1b92280cb26423` | ONNX STT and diarization |
| sherpa-onnx-core | 2.0.2 | 2026-11-19 | Apache-2.0 | `sherpa_onnx_core-2.0.2-py3-none-manylinux2014_aarch64.whl`, 13,615,407 B, `41df86dec3e321b0e40d8d6970aff294006eb65f6d3a4410aaddd8c9a42fc85a` | native library bundle (its own ONNX Runtime build) |

Locked in `services/audio/uv.lock`: 21 new packages and no removed or changed entry (diffed against the lock before the
change). Installed size added to the benchmark image: 424 MB venv (ctranslate2 67 MB, onnxruntime 63 MB, av.libs 54 MB, sherpa_onnx 45 MB,
av 38 MB); image 1.38 GB against 997 MB for the Phase 2B VAD image.

### Findings that matter for the selection (flagged, not decided)

1. **PyAV bundles GPL codecs.** `av` 19.0.2's FFmpeg build exposes `libx264` and `libx265` (GPL-2.0-or-later) next to
   `libmp3lame`, `libopus`, `libvpx`, `libdav1d` (observed with `av.codecs_available` in the image). faster-whisper
   requires `av` (file decoding only). If faster-whisper were ever selected, `av` would enter the runtime image and
   needs a licence review (or a build without the GPL components). Not a legal opinion.
2. **huggingface-hub 2.4.0** pulls `hf-xet` (a Rust binary) and `httpx2`; nothing is called at benchmark time and the
   containers have no network, but the supply chain is larger than the model needs.
3. **Telemetry.** `onnxruntime` (via faster-whisper) is the same wheel as in Phase 2B, which logs a telemetry component.
   `sherpa-onnx-core` ships its own ONNX Runtime build; it was not inspected for telemetry beyond running with
   `--network none`. whisper.cpp / ctranslate2: no network code was observed; not audited.
4. **Wheel build flags.** The pywhispercpp aarch64 wheel reports `NEON = 1 | ARM_FMA = 1 | OPENMP = 1 | REPACK = 1`
   and no dot-product or i8mm features, so its quantised kernels are probably slower than a source build tuned for the
   CPU. The numbers below are for the pinned wheel, not for the best possible whisper.cpp build.

## Models (every file is hash-checked by the harness before load; `models.lock.json` is the pin)

Downloaded with `curl` from commit-pinned or release URLs (no account, no terms page, nothing sent but the HTTP
request). "Upstream-verified" means the hosting service itself publishes the same SHA-256 (Hugging Face LFS oid or
GitHub release asset digest) and the harness compared it with its own hash; otherwise the hash is a first-download pin.

| File | Bytes | SHA-256 | Upstream-verified |
| --- | --- | --- | --- |
| `diar-embedding/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` | 29,596,979 | `98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5` | yes |
| `diar-embedding/wespeaker_en_voxceleb_resnet34_LM.onnx` | 26,530,550 | `e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012` | yes |
| `diar-segmentation/LICENSE` | 1,061 | `14d7016ad68e7394d6e6b78d96cc2ae431c905287b89674cfdf021e79e62b8ba` | no (first-download pin) |
| `diar-segmentation/README.md` | 115 | `0380ed76a50efcc421dc62f251ed06e8349688466beac3177bee6e00dc336bfc` | no (first-download pin) |
| `diar-segmentation/model.int8.onnx` | 1,540,506 | `d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d` | no (first-download pin) |
| `diar-segmentation/model.onnx` | 5,992,913 | `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079` | no (first-download pin) |
| `fw-medium/config.json` | 2,257 | `3622a2ddc41ec0e0fd4e68c13c6830f03b90c38d89aaad184de02c8c642cf807` | no (first-download pin) |
| `fw-medium/model.bin` | 1,527,906,378 | `9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae` | yes |
| `fw-medium/tokenizer.json` | 2,203,239 | `fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab` | no (first-download pin) |
| `fw-medium/vocabulary.txt` | 459,861 | `34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913` | no (first-download pin) |
| `fw-small/config.json` | 2,370 | `b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828` | no (first-download pin) |
| `fw-small/model.bin` | 483,546,902 | `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671` | yes |
| `fw-small/tokenizer.json` | 2,203,239 | `fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab` | no (first-download pin) |
| `fw-small/vocabulary.txt` | 459,861 | `34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913` | no (first-download pin) |
| `ggml/ggml-medium-q5_0.bin` | 539,212,467 | `19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f` | yes |
| `ggml/ggml-small-q5_1.bin` | 190,085,487 | `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb` | yes |
| `sherpa-omni-300m/model.int8.onnx` | 365,841,453 | `e3042b2f3b3ef0af2211bf99d2b4bf94a21f5ac0e9898827e7dd6d003a860e91` | no (first-download pin) |
| `sherpa-omni-300m/tokens.txt` | 90,630 | `7d99997ef207ff14c2cfe825f2aa037528ea250113cc3c6392bfe49326884ba6` | no (first-download pin) |
| `sherpa-whisper-medium/medium-decoder.int8.onnx` | 571,059,257 | `595d00a338a365a7bfa0ca7f296cabc639583bef770ab6130df90f49a6412747` | no (first-download pin) |
| `sherpa-whisper-medium/medium-encoder.int8.onnx` | 374,196,283 | `1c54582b4d829de0089f6cb63bbbdb3bf7555398bacaf855fbecf1a84dfd193e` | no (first-download pin) |
| `sherpa-whisper-medium/medium-tokens.txt` | 816,730 | `b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126` | no (first-download pin) |
| `sherpa-whisper-small/small-decoder.int8.onnx` | 262,226,114 | `acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee` | no (first-download pin) |
| `sherpa-whisper-small/small-encoder.int8.onnx` | 112,442,483 | `4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9` | no (first-download pin) |
| `sherpa-whisper-small/small-tokens.txt` | 816,730 | `b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126` | no (first-download pin) |

Archives (the extracted files above are what is loaded; the archives are not in any image):

| Archive | SHA-256 |
| --- | --- |
| `sherpa-onnx-whisper-small.tar.bz2` (639,387,718 B) | `486a46afbb7ba798507190ffe02fea2dd726049af212e774537efac6afb210a6` |
| `sherpa-onnx-whisper-medium.tar.bz2` (1,931,372,882 B) | `614b1172557049069d846c29d9399640bce83a4dd6c580decebd9ce2a4f32c33` |
| `sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05.tar.bz2` (292,313,120 B) | `951b32409aade32bd525310bb39e9666773ba3fc611a39e817f620936d76c631` (equals the GitHub digest) |
| `sherpa-onnx-pyannote-segmentation-3-0.tar.bz2` (6,958,444 B) | `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488` |

### Source, licence of the weights, maintenance

| Model | Source (pinned) | Weights licence and basis | Notes |
| --- | --- | --- | --- |
| Whisper small / medium, CTranslate2 | `Systran/faster-whisper-small` @ `536b0662742c02347bc0e980a01041f333bce120`, `-medium` @ `08e178d48790749d25932bbc082711ddcfdfbc4f` (Hugging Face, `gated: false`) | MIT (model card `license: mit`; OpenAI Whisper repo `LICENSE` at v20250625 is MIT and covers the weights) | Files were last modified 2023-11-23. The file is float16 (483 MB / 1.53 GB); "int8" is applied at load (`compute_type="int8"`) |
| Whisper small q5_1 / medium q5_0, ggml | `ggerganov/whisper.cpp` @ `5359861c739e955e79d9a303bcbc70fb988958b1` (`gated: false`, `license: mit`) | MIT | Quantised on disk (190 MB / 539 MB), loaded as such |
| Whisper small / medium, ONNX int8 | k2-fsa/sherpa-onnx release `asr-models` (assets last updated 2024-07-13) | MIT (exported from OpenAI Whisper) | Only the int8 encoder/decoder and tokens are extracted; the archives also hold fp32 files |
| Omnilingual ASR 300M CTC v2, int8 | k2-fsa/sherpa-onnx release `asr-models` (2026-02-05), exported from `facebookresearch/omnilingual-asr` | Apache-2.0 (`LICENSE` of the repository: Apache 2.0, Meta; Hugging Face card of `facebook/omniASR-CTC-300M`: `license: apache-2.0`, `gated: false`) | 1,600+ languages, Hindi included; CTC output has no casing or punctuation. GitHub licence API reports NOASSERTION only because of the file header format |
| pyannote segmentation-3.0, ONNX | k2-fsa/sherpa-onnx release `speaker-segmentation-models`, `sherpa-onnx-pyannote-segmentation-3-0.tar.bz2` | MIT (`LICENSE` inside the archive: MIT, Copyright 2022 CNRS) | The original `pyannote/segmentation-3.0` on Hugging Face is `gated: auto` (it asks for contact details): **not used**. The GitHub export has no gate. Training data of the original (AMI, AISHELL, AliMeeting, AVA-AVD, DIHARD, Ego4D, MSDWild, REPERE, VoxConverse) carries its own terms; not assessed |
| 3D-Speaker CAM++ (en, VoxCeleb) | k2-fsa/sherpa-onnx release `speaker-recongition-models` | Apache-2.0 (ModelScope API `iic/speech_campplus_sv_en_voxceleb_16k`: "Apache License 2.0"; 3D-Speaker repo Apache-2.0) | Trained on VoxCeleb (English celebrity speech); dataset terms not assessed |
| WeSpeaker ResNet34-LM (en, VoxCeleb) | same release | Code Apache-2.0 (`LICENSE` at wespeaker v1.2.0); the WeSpeaker docs state the model "follows the license of its dataset": VoxCeleb, CC BY 4.0 | WeSpeaker last release v1.2.0 (2023-07-23), repo pushed 2026-09-22 |

Offline operation: every model above loads from a local path with no network (the containers run `--network none`).

## Excluded candidates (with reasons)

| Candidate | Reason |
| --- | --- |
| `pyannote.audio` 4.1.1 (MIT) with `pyannote/speaker-diarization-3.1` or `community-1` | Requires PyTorch (`torch>=2.8`, `torchaudio`, `torchcodec`, `lightning`, `opentelemetry-*`): no wheel-size budget on an 8 GB machine (ADR-0034), and the pipelines are gated on Hugging Face (accept terms and share contact details), which the constraints exclude. Only its ONNX segmentation export is used, via sherpa-onnx |
| AI4Bharat IndicConformer / IndicWhisper / NeMo Conformer models | Need NeMo and PyTorch to run, or have no maintained ONNX/CT2 export with a verified licence in the time box. Not evaluated |
| Whisper large-v3 / turbo | Out of the requested scope (small, medium) and over the memory budget on this machine; not evaluated |
| Dolphin (sherpa-onnx) and SenseVoice | Not evaluated: SenseVoice has no Hindi; Dolphin was not assessed (licence and language list not verified). Omnilingual 300M is the one Indic-capable non-Whisper model measured |
| NVIDIA / Meta gated or click-through models | Excluded on principle (account or terms acceptance would send the user's details to an external service) |
