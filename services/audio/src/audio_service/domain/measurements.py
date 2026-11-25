"""Deterministic signal measurements (plan §8, §9, ADR-0019): numbers with units, nothing else.

Every quantity carries its unit, its kind (measured / derived / estimate) and its method. There is
no category, score, verdict or recommendation here; interpretation belongs to the future Audio
Quality agent. Values that are mathematically undefined for the signal (a level of digital
silence, a ratio with a zero denominator) are listed as `unavailable` with a reason, never guessed.

Memory is bounded by construction: both analysers consume one decoder block at a time, in chunks
of `CHUNK_FRAMES`, with float64 accumulators (sums of integer squares are exact) and no copy of the
whole signal. Results are rounded (`DB_DECIMALS`, `LINEAR_DECIMALS`) so the serialised record is
byte-identical across runs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from audio_service.contracts import (
    ChannelMeasurements,
    MeasurementRecord,
    Quantity,
    QuantityKind,
    QuantityUnit,
    Unavailable,
)

CHUNK_FRAMES = 32_768
DB_DECIMALS = 3
LINEAR_DECIMALS = 9
SERIES_DB_DECIMALS = 2
INT16_FULL_SCALE = 32768.0

F32 = npt.NDArray[np.float32]
I16 = npt.NDArray[np.int16]


def quantity(value: float, unit: QuantityUnit, kind: QuantityKind, method: str) -> Quantity:
    decimals = (
        DB_DECIMALS if unit in ("dBFS", "dB", "LUFS", "LU", "dBTP", "ms") else LINEAR_DECIMALS
    )
    rounded = value if unit in ("samples", "count") else round(float(value), decimals)
    return Quantity(
        value=int(rounded) if unit in ("samples", "count") else rounded,
        unit=unit,
        kind=kind,
        method=method,
    )


def to_db(amplitude: float) -> float | None:
    """20 log10 of a linear amplitude relative to full scale; None for zero (minus infinity)."""
    return None if amplitude <= 0 else 20.0 * math.log10(amplitude)


# -- full-scale rule: which native samples count as clipped ----------------------------------


@dataclass(frozen=True)
class FullScaleRule:
    """Samples at or beyond full scale. Integer sources: exactly the extreme codes, which FFmpeg
    converts to float as +(2^(b-1)-1)/2^(b-1) and -1.0 (exact in float32 up to 24 bits; above that
    the positive threshold rounds to 1.0). Float sources: |x| >= 1.0."""

    positive: np.float32
    negative: np.float32
    description: str


def full_scale_rule(sample_format: str, bits_per_raw_sample: int | None) -> FullScaleRule:
    base = sample_format.removesuffix("p")
    bits: int | None = None
    if base == "u8":
        bits = 8
    elif base == "s16":
        bits = 16
    elif base in ("s32", "s64"):
        bits = bits_per_raw_sample if bits_per_raw_sample and 8 <= bits_per_raw_sample <= 32 else 32
    if bits is None:  # flt, dbl and anything unknown: floating-point full scale is +-1.0
        return FullScaleRule(
            np.float32(1.0), np.float32(-1.0), "float source: samples with |x| >= 1.0"
        )
    positive = np.float32((2 ** (bits - 1) - 1) / 2 ** (bits - 1))
    return FullScaleRule(
        positive, np.float32(-1.0), f"{bits}-bit integer source: samples at the extreme codes"
    )


class RunTracker:
    """Runs of consecutive True values across chunk boundaries."""

    def __init__(self, min_run: int) -> None:
        self._min = min_run
        self._open = 0
        self.runs = 0
        self.longest = 0

    def _close(self, length: int) -> None:
        if length >= self._min:
            self.runs += 1
            self.longest = max(self.longest, length)

    def feed(self, mask: npt.NDArray[np.bool_]) -> None:
        n = mask.size
        if n == 0:
            return
        edges = np.diff(mask.astype(np.int8), prepend=np.int8(0), append=np.int8(0))
        starts = np.flatnonzero(edges == 1)
        ends = np.flatnonzero(edges == -1)  # exclusive; the last may be n (run still open)
        lengths = (ends - starts).tolist()
        if self._open and (starts.size == 0 or starts[0] != 0):
            self._close(self._open)
            self._open = 0
        if starts.size and starts[0] == 0 and self._open:
            lengths[0] += self._open
            self._open = 0
        if starts.size and ends[-1] == n:
            self._open = int(lengths.pop())
        for length in lengths:
            self._close(int(length))

    def finish(self) -> None:
        if self._open:
            self._close(self._open)
            self._open = 0


# -- pass A: native-rate samples ------------------------------------------------------------------


@dataclass
class NativeStats:
    frames: int
    peak: npt.NDArray[np.float64]  # per channel, linear
    sumsq: npt.NDArray[np.float64]
    sums: npt.NDArray[np.float64]
    gram: npt.NDArray[np.float64]
    clipped: list[int]
    runs: list[int]
    longest: list[int]
    non_finite: int


class NativeAnalyzer:
    """Pass A: per-channel statistics on the decoded native-rate float32 blocks, before any
    resampling or downmix."""

    def __init__(self, channels: int, rule: FullScaleRule, *, min_run: int) -> None:
        self._channels = channels
        self._rule = rule
        self._frames = 0
        self._peak = np.zeros(channels, dtype=np.float64)
        self._sums = np.zeros(channels, dtype=np.float64)
        self._gram = np.zeros((channels, channels), dtype=np.float64)
        self._clipped = np.zeros(channels, dtype=np.int64)
        # Runs are counted per rail: a stretch at +full scale and one at -full scale are two runs.
        self._pos_runs = [RunTracker(min_run) for _ in range(channels)]
        self._neg_runs = [RunTracker(min_run) for _ in range(channels)]
        self._non_finite = 0

    def feed(self, block: F32) -> None:
        for start in range(0, block.shape[0], CHUNK_FRAMES):
            self._feed_chunk(block[start : start + CHUNK_FRAMES])

    def _feed_chunk(self, chunk: F32) -> None:
        wide = chunk.astype(np.float64)
        finite = np.isfinite(wide)
        if not finite.all():
            self._non_finite += int(finite.size - np.count_nonzero(finite))
            wide[~finite] = 0.0
        self._frames += chunk.shape[0]
        self._sums += wide.sum(axis=0)
        self._gram += wide.T @ wide
        self._peak = np.maximum(self._peak, np.abs(wide).max(axis=0))
        high = chunk >= self._rule.positive
        low = chunk <= self._rule.negative
        self._clipped += high.sum(axis=0) + low.sum(axis=0)
        for channel in range(self._channels):
            self._pos_runs[channel].feed(high[:, channel])
            self._neg_runs[channel].feed(low[:, channel])

    def finish(self) -> NativeStats:
        for tracker in (*self._pos_runs, *self._neg_runs):
            tracker.finish()
        return NativeStats(
            frames=self._frames,
            peak=self._peak,
            sumsq=np.diag(self._gram).copy(),
            sums=self._sums,
            gram=self._gram,
            clipped=[int(c) for c in self._clipped],
            runs=[p.runs + n.runs for p, n in zip(self._pos_runs, self._neg_runs, strict=True)],
            longest=[
                max(p.longest, n.longest)
                for p, n in zip(self._pos_runs, self._neg_runs, strict=True)
            ],
            non_finite=self._non_finite,
        )


class _Builder:
    """Collects quantities and the reasons the missing ones are missing."""

    def __init__(self) -> None:
        self.quantities: dict[str, Quantity] = {}
        self.unavailable: list[Unavailable] = []

    def _add(  # noqa: PLR0913, PLR0917
        self,
        name: str,
        value: float | None,
        unit: QuantityUnit,
        method: str,
        kind: QuantityKind,
        reason: str,
    ) -> None:
        if value is None or not math.isfinite(value):
            self.unavailable.append(Unavailable(name=name, reason=reason))
        else:
            self.quantities[name] = quantity(value, unit, kind, method)

    def measured(
        self,
        name: str,
        value: float | None,
        unit: QuantityUnit,
        method: str,
        *,
        reason: str = "digital_silence",
    ) -> None:
        self._add(name, value, unit, method, "measured", reason)

    def derived(
        self,
        name: str,
        value: float | None,
        unit: QuantityUnit,
        method: str,
        *,
        reason: str = "digital_silence",
    ) -> None:
        self._add(name, value, unit, method, "derived", reason)

    def estimate(
        self,
        name: str,
        value: float | None,
        unit: QuantityUnit,
        method: str,
        *,
        reason: str = "digital_silence",
    ) -> None:
        self._add(name, value, unit, method, "estimate", reason)


def _level_quantities(  # noqa: PLR0913
    out: _Builder,
    *,
    peak: float,
    rms: float,
    samples: int,
    clipped: int,
    runs: int,
    longest: int,
    rule: FullScaleRule,
) -> None:
    peak_db, rms_db = to_db(peak), to_db(rms)
    out.measured("peakLinear", peak, "fullscale", "max |x| over decoded samples")
    out.measured("peakDbfs", peak_db, "dBFS", "20 log10(max |x|), 0 dBFS = full scale")
    out.measured("rmsLinear", rms, "fullscale", "sqrt(mean(x^2)), float64 sums")
    out.measured("rmsDbfs", rms_db, "dBFS", "20 log10(RMS), 0 dBFS = full scale")
    crest = None if peak_db is None or rms_db is None else peak_db - rms_db
    out.derived("crestFactorDb", crest, "dB", "peak dBFS minus RMS dBFS")
    out.measured("clippedSamples", clipped, "samples", rule.description)
    ratio = clipped / max(samples, 1)
    out.derived("clippedRatio", ratio, "ratio", "clipped samples / samples")
    out.measured(
        "clippedRuns",
        runs,
        "count",
        "runs of consecutive clipped samples at one rail (minimum length from config)",
    )
    out.measured(
        "longestClippedRunSamples",
        longest,
        "samples",
        "longest run of consecutive clipped samples",
    )


def original_record(
    stats: NativeStats,
    *,
    sample_rate_hz: int,
    rule: FullScaleRule,
    loudness: dict[str, Quantity],
    loudness_unavailable: list[Unavailable],
) -> MeasurementRecord:
    channels, frames = stats.sumsq.size, stats.frames
    top = _Builder()
    per: list[ChannelMeasurements] = []
    for channel in range(channels):
        b = _Builder()
        rms = math.sqrt(stats.sumsq[channel] / frames) if frames else 0.0
        _level_quantities(
            b,
            peak=float(stats.peak[channel]),
            rms=rms,
            samples=frames,
            clipped=stats.clipped[channel],
            runs=stats.runs[channel],
            longest=stats.longest[channel],
            rule=rule,
        )
        dc = float(stats.sums[channel] / frames) if frames else 0.0
        b.measured("dcOffset", dc, "fullscale", "mean(x), signed, relative to full scale")
        per.append(ChannelMeasurements(channel=channel, quantities=b.quantities))
    rms_all = math.sqrt(float(stats.sumsq.sum()) / (frames * channels)) if frames else 0.0
    _level_quantities(
        top,
        peak=float(stats.peak.max()),
        rms=rms_all,
        samples=frames * channels,
        clipped=sum(stats.clipped),
        runs=sum(stats.runs),
        longest=max(stats.longest),
        rule=rule,
    )
    if channels < 2:
        top.unavailable.append(Unavailable(name="interChannelCorrelation", reason="mono_source"))
    else:
        n = float(frames)
        for i in range(channels):
            for j in range(i + 1, channels):
                var_i = n * stats.gram[i, i] - stats.sums[i] ** 2
                var_j = n * stats.gram[j, j] - stats.sums[j] ** 2
                name = f"correlationCh{i}Ch{j}"
                if var_i <= 0 or var_j <= 0:
                    top.unavailable.append(Unavailable(name=name, reason="zero_variance"))
                    continue
                cov = n * stats.gram[i, j] - stats.sums[i] * stats.sums[j]
                r = max(-1.0, min(1.0, float(cov / math.sqrt(var_i * var_j))))
                top.measured(name, r, "ratio", "Pearson correlation of the two channels")
    top.quantities.update(loudness)
    top.unavailable.extend(loudness_unavailable)
    return MeasurementRecord(
        measurementsSchemaVersion=1,
        source="original_decoded",
        sampleRateHz=sample_rate_hz,
        channels=channels,
        frames=frames,
        quantities=top.quantities,
        perChannel=per,
        unavailable=top.unavailable,
    )


# -- pass B: canonical 16 kHz mono ----------------------------------------------------------------


@dataclass
class LevelWindows:
    rms: npt.NDArray[np.float64]  # linear, relative to full scale
    peak: npt.NDArray[np.float64]


@dataclass
class CanonicalStats:
    samples: int
    sumsq: int
    peak: int
    windows: LevelWindows
    interval_ms: int


class CanonicalAnalyzer:
    """Pass B: level statistics and the windowed level series of the canonical int16 stream."""

    def __init__(self, *, sample_rate_hz: int, interval_ms: int) -> None:
        self._window = sample_rate_hz * interval_ms // 1000
        self._interval_ms = interval_ms
        self._samples = 0
        self._sumsq = 0
        self._peak = 0
        self._pending_n = 0
        self._pending_sumsq = 0
        self._pending_peak = 0
        self._rms: list[npt.NDArray[np.float64]] = []
        self._peaks: list[npt.NDArray[np.float64]] = []

    def feed(self, block: I16) -> None:
        for start in range(0, block.shape[0], CHUNK_FRAMES):
            self._feed_chunk(block[start : start + CHUNK_FRAMES])

    def _close_pending(self) -> None:
        rms = math.sqrt(self._pending_sumsq / self._pending_n) / INT16_FULL_SCALE
        self._rms.append(np.array([rms]))
        self._peaks.append(np.array([self._pending_peak / INT16_FULL_SCALE]))
        self._pending_n = self._pending_sumsq = self._pending_peak = 0

    def _feed_chunk(self, chunk: I16) -> None:
        wide = chunk.astype(np.int64)
        self._samples += chunk.size
        self._sumsq += int(np.dot(wide, wide))
        self._peak = max(self._peak, int(np.abs(wide).max()))
        pos = 0
        if self._pending_n:
            take = min(self._window - self._pending_n, wide.size)
            head = wide[:take]
            self._pending_n += take
            self._pending_sumsq += int(np.dot(head, head))
            self._pending_peak = max(self._pending_peak, int(np.abs(head).max()))
            pos = take
            if self._pending_n == self._window:
                self._close_pending()
        full = (wide.size - pos) // self._window
        if full:
            body = wide[pos : pos + full * self._window].reshape(full, self._window)
            sumsq = np.einsum("ij,ij->i", body, body).astype(np.float64)
            self._rms.append(np.sqrt(sumsq / self._window) / INT16_FULL_SCALE)
            self._peaks.append(np.abs(body).max(axis=1) / INT16_FULL_SCALE)
            pos += full * self._window
        tail = wide[pos:]
        if tail.size:
            self._pending_n = tail.size
            self._pending_sumsq = int(np.dot(tail, tail))
            self._pending_peak = int(np.abs(tail).max())

    def finish(self) -> CanonicalStats:
        if self._pending_n:  # the final window may be shorter than the interval
            self._close_pending()
        empty = np.zeros(0, dtype=np.float64)
        return CanonicalStats(
            samples=self._samples,
            sumsq=self._sumsq,
            peak=self._peak,
            windows=LevelWindows(
                rms=np.concatenate(self._rms) if self._rms else empty,
                peak=np.concatenate(self._peaks) if self._peaks else empty,
            ),
            interval_ms=self._interval_ms,
        )


def db_array(linear: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    """20 log10 per element, -inf for zero."""
    with np.errstate(divide="ignore"):
        return np.asarray(20.0 * np.log10(linear), dtype=np.float64)


def canonical_record(
    stats: CanonicalStats, *, sample_rate_hz: int, silence_threshold_centi_dbfs: int
) -> MeasurementRecord:
    out = _Builder()
    samples = stats.samples
    rms = math.sqrt(stats.sumsq / samples) / INT16_FULL_SCALE if samples else 0.0
    peak = stats.peak / INT16_FULL_SCALE
    out.measured("sampleCount", samples, "samples", "decoded canonical samples")
    out.derived("durationMs", samples * 1000 / sample_rate_hz, "ms", "samples / 16 at 16 kHz")
    out.measured("peakLinear", peak, "fullscale", "max |x| over canonical samples")
    out.measured("peakDbfs", to_db(peak), "dBFS", "20 log10(max |x|), 0 dBFS = full scale")
    out.measured("rmsLinear", rms, "fullscale", "sqrt(mean(x^2)), exact integer sums")
    out.measured("rmsDbfs", to_db(rms), "dBFS", "20 log10(RMS), 0 dBFS = full scale")
    windows = db_array(stats.windows.rms)
    count = int(windows.size)
    if count:
        threshold = silence_threshold_centi_dbfs / 100
        below = int(np.count_nonzero(windows < threshold))
        out.derived(
            "silenceRatio",
            below / count,
            "ratio",
            f"share of {stats.interval_ms} ms windows with RMS below {threshold:.2f} dBFS",
        )
        floor = float(np.sort(windows)[(count - 1) // 10])
        out.estimate(
            "noiseFloorDbfs",
            floor,
            "dBFS",
            f"10th percentile of {stats.interval_ms} ms window RMS (lower index); not an SNR",
        )
    else:
        out.unavailable.append(Unavailable(name="silenceRatio", reason="no_windows"))
        out.unavailable.append(Unavailable(name="noiseFloorDbfs", reason="no_windows"))
    out.unavailable.append(Unavailable(name="snr", reason="no_speech_split"))
    out.unavailable.append(Unavailable(name="harmonicDistortion", reason="no_reference"))
    return MeasurementRecord(
        measurementsSchemaVersion=1,
        source="canonical",
        sampleRateHz=sample_rate_hz,
        channels=1,
        frames=samples,
        quantities=out.quantities,
        perChannel=[],
        unavailable=out.unavailable,
    )


def level_series_chunks(stats: CanonicalStats, *, sample_rate_hz: int) -> list[bytes]:
    """`level-series.json` as UTF-8 chunks (compact, `null` for digital silence).

    A measurement series, not waveform peaks: it must not be served as peaks until OD-39 is decided.
    """
    rms, peak = db_array(stats.windows.rms), db_array(stats.windows.peak)

    def fmt(values: npt.NDArray[np.float64], lo: int, hi: int) -> str:
        return ",".join(
            "null" if not math.isfinite(v) else f"{v:.{SERIES_DB_DECIMALS}f}"
            for v in values[lo:hi].tolist()
        )

    count = int(rms.size)
    out = [
        (
            f'{{"schemaVersion":1,"intervalMs":{stats.interval_ms},"sampleRateHz":{sample_rate_hz},'
            f'"windows":{count},"rmsDbfs":['
        ).encode()
    ]
    for name, values in (("rms", rms), ("peak", peak)):
        if name == "peak":
            out.append(b'],"peakDbfs":[')
        for lo in range(0, count, 10_000):
            out.append(
                ("," if lo else "").encode() + fmt(values, lo, min(count, lo + 10_000)).encode()
            )
    out.append(b"]}")
    return out


# -- per-segment record (Phase 2B WS6) -------------------------------------------------------


def segment_record(
    *, samples: int, sumsq: int, peak: int, speech_ms: int, vad_method: str
) -> MeasurementRecord:
    """Canonical-audio measurements of one speech segment. Same quantity format as the whole
    recording; no judgements. `speechMs` is an estimate: it counts the 10 ms frames the detector
    flagged."""
    out = _Builder()
    rms = math.sqrt(sumsq / samples) / INT16_FULL_SCALE if samples else 0.0
    peak_linear = peak / INT16_FULL_SCALE
    out.measured("sampleCount", samples, "samples", "canonical samples in the segment")
    out.derived("durationMs", samples * 1000 / 16_000, "ms", "samples / 16 at 16 kHz")
    out.measured("peakLinear", peak_linear, "fullscale", "max |x| over the segment samples")
    out.measured("peakDbfs", to_db(peak_linear), "dBFS", "20 log10(max |x|), 0 dBFS = full scale")
    out.measured("rmsLinear", rms, "fullscale", "sqrt(mean(x^2)), exact integer sums")
    out.measured("rmsDbfs", to_db(rms), "dBFS", "20 log10(RMS), 0 dBFS = full scale")
    out.estimate(
        "speechMs", speech_ms, "ms", f"10 ms frames flagged as speech by the '{vad_method}' VAD"
    )
    return MeasurementRecord(
        measurementsSchemaVersion=1,
        source="canonical",
        sampleRateHz=16_000,
        channels=1,
        frames=samples,
        quantities=out.quantities,
        perChannel=[],
        unavailable=out.unavailable,
    )
