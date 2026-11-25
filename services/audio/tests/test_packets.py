"""Incremental packet-list parsing (plan §11.2)."""

from __future__ import annotations

import pytest

from audio_service.domain.packets import PacketScanner, PacketStreamError


def scan(text: str, *, tolerance: int = 1, chunk: int | None = None):  # type: ignore[no-untyped-def]
    scanner = PacketScanner(tolerance)
    data = text.encode()
    if chunk is None:
        scanner.feed(data)
    else:
        for i in range(0, len(data), chunk):
            scanner.feed(data[i : i + chunk])
    return scanner.finish()


def lines(*rows: str) -> str:
    return "\n".join(rows) + "\n"


CLEAN = lines("0,0,100,K__", "100,100,100,K__", "200,200,100,K__")


def test_clean_stream_has_no_events() -> None:
    result = scan(CLEAN)
    assert (result.packets, result.first_pts, result.last_end) == (3, 0, 300)
    assert (result.gap_count, result.overlap_count, result.non_monotonic) == (0, 0, 0)
    assert result.max_duration_ticks == 100


@pytest.mark.parametrize("chunk", [1, 2, 3, 7, 1000])
def test_result_is_independent_of_chunking(chunk: int) -> None:
    text = lines("0,0,100,K__", "100,100,100,K__", "500,500,100,K__", "600,600,100,K__")
    assert scan(text, chunk=chunk) == scan(text)


def test_a_gap_is_recorded_with_position_and_size() -> None:
    result = scan(lines("0,0,100,K__", "100,100,100,K__", "500,500,100,K__", "600,600,100,K__"))
    assert result.gap_count == 1
    assert (result.gaps[0].at_ticks, result.gaps[0].duration_ticks) == (200, 300)


def test_a_single_dropped_packet_is_a_gap_of_one_duration() -> None:
    result = scan(lines("0,0,100,K__", "100,100,100,K__", "300,300,100,K__"))
    assert result.gap_count == 1 and result.gaps[0].duration_ticks == 100


def test_jitter_within_half_a_packet_is_not_a_gap() -> None:
    assert scan(lines("0,0,100,K__", "130,130,100,K__", "225,225,100,K__")).gap_count == 0


def test_the_minimum_tolerance_applies_to_short_packets() -> None:
    text = lines("0,0,10,K__", "40,40,10,K__")
    assert scan(text, tolerance=1).gap_count == 1
    assert scan(text, tolerance=50).gap_count == 0


def test_overlap_and_non_monotonic_pts() -> None:
    result = scan(lines("0,0,100,K__", "100,100,100,K__", "120,120,100,K__", "10,10,100,K__"))
    assert result.overlap_count == 1 and result.overlaps[0].at_ticks == 120
    assert result.non_monotonic == 1


def test_missing_pts_and_duration_are_counted() -> None:
    result = scan(lines("0,0,100,K__", "N/A,N/A,100,K__", "300,300,N/A,K__", "400,400,100,K__"))
    assert result.missing_pts == 1 and result.missing_duration == 1
    assert result.last_end == 500


def test_negative_priming_pts_and_skip_samples_side_data() -> None:
    result = scan(
        lines(
            "-1024,-1024,1024,KD_,Skip Samples,1024,0,0,0",
            "0,0,1024,K__",
            "1024,1024,1024,K__",
            "2048,2048,200,K__,Skip Samples,0,648,0,0",
        )
    )
    assert result.first_pts == -1024 and result.gap_count == 0
    assert result.skip_samples_first == 1024
    assert result.discard_padding_last == 648


def test_trailing_comma_from_empty_side_data_is_ignored() -> None:
    assert scan(lines("0,0,100,K__,", "100,100,100,K__")).packets == 2


def test_corrupt_flag_is_counted() -> None:
    result = scan(lines("0,0,100,K__", "100,100,50,K_C"))
    assert result.corrupt_packets == 1


def test_event_lists_are_bounded_but_counts_are_exact() -> None:
    rows = [f"{i * 300},{i * 300},100,K__" for i in range(1000)]
    result = scan(lines(*rows))
    assert result.gap_count == 999
    assert len(result.gaps) == 256


def test_last_line_without_a_newline_is_parsed() -> None:
    assert scan("0,0,100,K__\n100,100,100,K__").packets == 2


@pytest.mark.parametrize("text", ["1,2\n", "a,b,c,d\n", "0,0,xyz,K__\n"])
def test_malformed_lines_raise(text: str) -> None:
    with pytest.raises(PacketStreamError):
        scan(text)


def test_an_unbounded_line_raises_instead_of_buffering() -> None:
    scanner = PacketScanner(1)
    with pytest.raises(PacketStreamError):
        scanner.feed(b"1" * 5000)


def test_memory_stays_bounded_over_a_long_stream() -> None:
    scanner = PacketScanner(1)
    for i in range(200_000):  # about a 1.2 h MP3 worth of packets
        scanner.feed(f"{i * 100},{i * 100},100,K__\n".encode())
    result = scanner.finish()
    assert result.packets == 200_000 and result.gap_count == 0
