"""Pinned FFmpeg/ffprobe input controls for untrusted media (plan §6.1) and stderr classification.

`CODEC_WHITELIST` is matched by FFmpeg against *decoder* names (measured in the image, FFmpeg 7.1.5:
`mp3` alone does not admit the `mp3float` decoder, so both are listed). It is the only place the
names are fixed. `mjpeg` and `png` are admitted solely so that attached cover art (ID3 APIC, MP4
`covr`) does not make ffprobe fail: `avformat_find_stream_info` opens the decoder of every stream,
attached pictures included, and a whitelist that refuses them rejects ordinary tagged MP3 and M4A
files (measured; VERIFICATION_REMEDIATION.md).

RESIDUAL RISK: the attached picture's decoder IS reached, and a hostile cover image is parsed by
FFmpeg's mjpeg/png decoder inside the probe's ffprobe runs (`-vn` only keeps it out of the *output*
of the ffmpeg decode passes; it does not stop `find_stream_info`). It cannot be removed:
`-nofind_stream_info` loses the sample rate, channels and sample format the probe needs, and
`-allowed_media_types` is not a demuxer option in 7.1.5. The exposure is contained, not eliminated,
by Landlock (no files, no TCP, no signals or abstract sockets beyond the child), the rlimits
(CPU, FSIZE=0, NOFILE, CORE), `-max_alloc`, the process-group kill and the container's cgroup
(memory, pids). Outcomes for malformed pictures are covered by container tests. A real video track
(mpeg4, h264, ...) is refused: ffprobe fails with "not on whitelist", which maps to
UNSUPPORTED_FORMAT.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

CODEC_WHITELIST = ",".join(
    (
        # PCM family, both endians
        "pcm_u8",
        "pcm_s8",
        "pcm_s16le",
        "pcm_s16be",
        "pcm_s24le",
        "pcm_s24be",
        "pcm_s32le",
        "pcm_s32be",
        "pcm_f32le",
        "pcm_f32be",
        "pcm_f64le",
        "pcm_f64be",
        # compressed audio
        "mp3float",
        "mp3",
        "aac",
        "alac",
        "flac",
        "vorbis",
        "opus",
        "libopus",
        # attached cover art only: ffprobe's find_stream_info does open these decoders (residual
        # risk, see the module docstring)
        "mjpeg",
        "png",
    )
)
FORMAT_WHITELIST = "wav,mp3,mov,mp4,m4a,3gp,3g2,mj2,flac,ogg,matroska,webm"
PROBESIZE_BYTES = 5_000_000
ANALYZEDURATION_US = 10_000_000
MAX_ALLOC_BYTES = 268_435_456
FFPROBE_JSON_CAP_BYTES = 256 * 1024
LOSSLESS_CODEC = re.compile(r"^(pcm_.*|flac|alac)$")

# Options only the MOV demuxer accepts (anything else fails with "Option not found").
_MOV_ONLY = ("-enable_drefs", "0", "-use_absolute_path", "0")


def input_options(demuxer: str) -> list[str]:
    """Input options shared by every ffprobe/ffmpeg invocation. `-f` forces the sniffed demuxer."""
    options = [
        "-f",
        demuxer,
        "-format_whitelist",
        FORMAT_WHITELIST,
        "-codec_whitelist",
        CODEC_WHITELIST,
        "-probesize",
        str(PROBESIZE_BYTES),
        "-analyzeduration",
        str(ANALYZEDURATION_US),
    ]
    if demuxer == "mov":
        options += _MOV_ONLY
    return options


GLOBAL_ARGS = ["-max_alloc", str(MAX_ALLOC_BYTES)]


@dataclass
class StderrClasses:
    """Counts only. The stderr text itself is discarded: it can contain file metadata."""

    decode_errors: int = 0
    whitelist_refusals: int = 0
    compensation_failures: int = 0
    truncated: bool = False  # stderr hit the runner's cap, so counts are lower bounds

    @property
    def total(self) -> int:
        return self.decode_errors + self.whitelist_refusals + self.compensation_failures


_REPEATED = re.compile(rb"Last message repeated (\d+) times")


def classify_stderr(stderr: bytes, *, cap: int) -> StderrClasses:
    classes = StderrClasses(truncated=len(stderr) >= cap)
    last = "decode_errors"
    for line in stderr.splitlines():
        if not line.strip():
            continue
        repeated = _REPEATED.search(line)
        if repeated:  # "Last message repeated N times" repeats the previous line's class
            setattr(classes, last, getattr(classes, last) + int(repeated.group(1)))
            continue
        if b"not on whitelist" in line:
            last = "whitelist_refusals"
        elif b"Failed to compensate for timestamp delta" in line:
            last = "compensation_failures"
        else:
            last = "decode_errors"
        setattr(classes, last, getattr(classes, last) + 1)
    return classes


def refusal_code_hint(stderr: bytes) -> str:
    """'whitelist' when a codec/format/protocol allow-list refused the input, else 'other'."""
    return "whitelist" if b"not on whitelist" in stderr else "other"
