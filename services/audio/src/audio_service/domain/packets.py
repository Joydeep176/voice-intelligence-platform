"""Incremental parser for `ffprobe -show_entries packet=pts,dts,duration,flags:packet_side_data
-of csv=p=0` output (plan §11.2).

Lines arrive in arbitrary chunks and are consumed as they complete, so memory is bounded by one
line plus the (capped) gap and overlap lists, however long the file is. Only numbers and the
`Skip Samples` side data (priming / padding) are read; nothing else from the output is kept.
"""

from __future__ import annotations

from dataclasses import dataclass, field

MAX_LINE_BYTES = 4096
MAX_RECORDED_EVENTS = 256  # gaps / overlaps listed individually; further ones are only counted
GAP_TOLERANCE_FRACTION = 0.5  # of the previous packet's duration; at least `min_tolerance_ticks`


class PacketStreamError(Exception):
    """The ffprobe output was not what this parser expects (unbounded line, bad field)."""


@dataclass
class TimelineEvent:
    at_ticks: int  # position of the gap/overlap on the source timeline (stream ticks)
    duration_ticks: int


@dataclass
class PacketScan:
    packets: int = 0
    first_pts: int | None = None
    last_end: int | None = None  # pts + duration of the last packet with both known
    max_duration_ticks: int = 0
    missing_pts: int = 0
    missing_duration: int = 0
    non_monotonic: int = 0
    corrupt_packets: int = 0  # packets ffprobe flagged corrupt (for example a cut-off last packet)
    gaps: list[TimelineEvent] = field(default_factory=list)
    gap_count: int = 0
    overlaps: list[TimelineEvent] = field(default_factory=list)
    overlap_count: int = 0
    skip_samples_first: int | None = None  # priming / encoder delay from the first side data
    discard_padding_last: int | None = None  # end padding from the last side data


def _int(field_text: str) -> int | None:
    if field_text in ("", "N/A"):
        return None
    try:
        return int(field_text)
    except ValueError:
        raise PacketStreamError from None


class PacketScanner:
    """Feed it byte chunks; read `scan` afterwards. `min_tolerance_ticks` is the smallest gap
    tolerated (the caller passes about 1 ms in stream ticks, to absorb timestamp rounding)."""

    def __init__(self, min_tolerance_ticks: int) -> None:
        self.scan = PacketScan()
        self._min_tol = max(1, min_tolerance_ticks)
        self._buffer = bytearray()
        self._prev_pts: int | None = None
        self._prev_dur: int | None = None
        self._last_known_dur: int | None = None

    def feed(self, chunk: bytes) -> None:
        self._buffer += chunk
        start = 0
        while True:
            end = self._buffer.find(b"\n", start)
            if end < 0:
                break
            self._line(bytes(self._buffer[start:end]))
            start = end + 1
        del self._buffer[:start]
        if len(self._buffer) > MAX_LINE_BYTES:
            raise PacketStreamError

    def finish(self) -> PacketScan:
        if self._buffer.strip():
            self._line(bytes(self._buffer))
        self._buffer.clear()
        return self.scan

    def _line(self, raw: bytes) -> None:
        text = raw.decode("ascii", errors="replace").strip()
        if not text:
            return
        fields = text.split(",")
        if len(fields) < 4:  # noqa: PLR2004 - pts, dts, duration, flags
            raise PacketStreamError
        pts, duration = _int(fields[0]), _int(fields[2])
        scan = self.scan
        scan.packets += 1
        if len(fields[3]) >= 3 and fields[3][2] == "C":  # noqa: PLR2004 - flags "K_C": corrupt
            scan.corrupt_packets += 1
        if len(fields) >= 7 and fields[4] == "Skip Samples":  # noqa: PLR2004
            skip, padding = _int(fields[5]), _int(fields[6])
            if scan.skip_samples_first is None and skip is not None:
                scan.skip_samples_first = skip
            if padding is not None:
                scan.discard_padding_last = padding
        if duration is None or duration <= 0:
            scan.missing_duration += 1
            duration = None
        else:
            scan.max_duration_ticks = max(scan.max_duration_ticks, duration)
            self._last_known_dur = duration
        if pts is None:
            scan.missing_pts += 1
            self._prev_pts = None
            self._prev_dur = None
            return
        if scan.first_pts is None:
            scan.first_pts = pts
        if self._prev_pts is not None:
            self._compare(pts)
        if duration is not None:
            scan.last_end = pts + duration
        self._prev_pts, self._prev_dur = pts, duration

    def _compare(self, pts: int) -> None:
        assert self._prev_pts is not None  # noqa: S101
        scan = self.scan
        if pts < self._prev_pts:
            scan.non_monotonic += 1
            return
        prev_dur = self._prev_dur if self._prev_dur is not None else self._last_known_dur
        if prev_dur is None:
            return
        delta = pts - (self._prev_pts + prev_dur)
        tolerance = max(self._min_tol, int(prev_dur * GAP_TOLERANCE_FRACTION))
        if delta > tolerance:
            scan.gap_count += 1
            if len(scan.gaps) < MAX_RECORDED_EVENTS:
                scan.gaps.append(TimelineEvent(self._prev_pts + prev_dur, delta))
        elif -delta > tolerance:
            scan.overlap_count += 1
            if len(scan.overlaps) < MAX_RECORDED_EVENTS:
                scan.overlaps.append(TimelineEvent(pts, -delta))
