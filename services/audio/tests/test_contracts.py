"""Contract parity: every shared JSON fixture is validated by the Pydantic mirrors here and by the
zod schemas in packages/contracts (audio-service.test.ts). A fixture is
`<schema>.<label>.valid.json` or `<schema>.<label>.invalid.json`; both sides must accept and
reject exactly the same files, and a fixture whose schema is not mapped on either side
fails that side's suite.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from helpers import contracts_dir
from pydantic import BaseModel, Field, ValidationError

from audio_service.contracts import (
    CONTRACT_VERSION,
    CapabilitiesResponse,
    DiarizeConfig,
    DiarizeResult,
    ErrorCode,
    ErrorResponse,
    HandshakeRequest,
    HandshakeResponse,
    LevelSeries,
    MeasureConfig,
    MeasureResult,
    PreprocessConfig,
    PreprocessResult,
    ProbeResponse,
    ProbeResult,
    TaskAccepted,
    TaskCreateRequest,
    TaskStatusResponse,
    Timeline,
    TranscribeConfig,
    TranscribeResult,
    canonical_json,
    config_hash,
)


class ConfigHashVector(BaseModel):
    """Shape of `preprocess-config-hash.*` fixtures (mirrors the zod object in the TS test)."""

    model_config = {"extra": "forbid"}
    config: PreprocessConfig
    canonicalJson: str  # noqa: N815
    expectedHash: str = Field(pattern=r"^[0-9a-f]{64}$")  # noqa: N815


CONTRACTS = contracts_dir()
FIXTURES = CONTRACTS / "fixtures/audio-service"
TS_CONTRACT = CONTRACTS / "src/audio-service.ts"

SCHEMAS: dict[str, type[BaseModel]] = {
    "handshake-request": HandshakeRequest,
    "handshake-response": HandshakeResponse,
    "probe": ProbeResponse,
    "error": ErrorResponse,
    "task-create-request": TaskCreateRequest,
    "task-accepted": TaskAccepted,
    "task-status": TaskStatusResponse,
    "capabilities": CapabilitiesResponse,
    "probe-result": ProbeResult,
    "timeline": Timeline,
    "preprocess-config": PreprocessConfig,
    "preprocess-config-hash": ConfigHashVector,
    "preprocess-result": PreprocessResult,
    "level-series": LevelSeries,
    "transcribe-config": TranscribeConfig,
    "transcribe-result": TranscribeResult,
    "diarize-config": DiarizeConfig,
    "diarize-result": DiarizeResult,
    "measure-config": MeasureConfig,
    "measure-result": MeasureResult,
}


def fixture_files() -> list[Path]:
    return sorted(FIXTURES.glob("*.json"))


def load(path: Path) -> Any:
    return json.loads(path.read_text())


def test_fixtures_exist() -> None:
    assert len(fixture_files()) >= 20


@pytest.mark.parametrize("path", fixture_files(), ids=lambda p: p.name)
def test_fixture_is_accepted_or_rejected_as_named(path: Path) -> None:
    *_, label, ext = path.name.split(".")
    model = SCHEMAS[path.name.split(".")[0]]  # KeyError: schema not mirrored in Pydantic
    assert ext == "json" and label in {"valid", "invalid"}
    if label == "valid":
        model.model_validate(load(path))
    else:
        with pytest.raises(ValidationError):
            model.model_validate(load(path))


def test_contract_version_matches_typescript() -> None:
    assert f"AUDIO_SERVICE_CONTRACT_VERSION = '{CONTRACT_VERSION}'" in TS_CONTRACT.read_text()
    assert CONTRACT_VERSION == "2"


def test_error_codes_match_typescript() -> None:
    ts = TS_CONTRACT.read_text()
    block = ts[ts.index("AudioServiceErrorCode = z.enum([") :].split("]);")[0]
    ts_codes = {line.strip().strip("',") for line in block.splitlines()[1:] if line.strip()}
    assert ts_codes == {code.value for code in ErrorCode}


def test_config_hash_vectors_match_the_stored_canonical_json_and_hash() -> None:
    vectors = sorted(FIXTURES.glob("preprocess-config-hash.*.valid.json"))
    assert len(vectors) >= 3
    for path in vectors:
        vector = load(path)
        assert canonical_json(vector["config"]) == vector["canonicalJson"], path.name
        assert config_hash(vector["config"]) == vector["expectedHash"], path.name


def test_canonical_json_sorts_recursively_and_does_not_escape_non_ascii() -> None:
    value = {"b": [1, "é\n"], "a": {"z": 1, "y": '"'}}
    assert canonical_json(value) == '{"a":{"y":"\\"","z":1},"b":[1,"é\\n"]}'


@pytest.mark.parametrize("bad", [1.5, True, None, {"a": 0.1}, [float("nan")], {1: 2}])
def test_canonical_json_rejects_floats_booleans_and_null(bad: Any) -> None:
    with pytest.raises(ValueError):  # noqa: PT011
        canonical_json(bad)


def test_error_code_additions_are_not_retryable() -> None:
    from audio_service.domain.errors import is_retryable

    for code in (
        ErrorCode.INVALID_CONFIG,
        ErrorCode.CONFIG_HASH_MISMATCH,
        ErrorCode.TOOL_VERSION_MISMATCH,
    ):
        assert not is_retryable(code)


# -- speech segmentation (Phase 2B WS6; interim parameters, OD-10 Open) ---------------------------


def test_the_segmented_config_fixture_holds_the_interim_defaults() -> None:
    from audio_service.domain.segmentation import SegmentationParams

    config = PreprocessConfig.model_validate(
        load(FIXTURES / "preprocess-config.segmented.valid.json")
    )
    assert config.segmentation is not None
    assert SegmentationParams.from_config(config.segmentation) == SegmentationParams()
    assert "OD-10" in TS_CONTRACT.read_text()


def test_a_none_config_omits_segmentation_so_existing_hashes_do_not_change() -> None:
    config = load(FIXTURES / "preprocess-config.valid.json")
    assert "segmentation" not in config
    assert config_hash(config) == "68aba914992a945d8c7adf4707ca3d731d6112f79c98b693519d648a9f94fed1"
    # the segmented config is a different configuration, so a different output prefix
    segmented = load(FIXTURES / "preprocess-config.segmented.valid.json")
    assert config_hash(segmented) != config_hash(config)
    with pytest.raises(ValueError):  # noqa: PT011
        canonical_json({**config, "segmentation": None})  # the canonical JSON has no null


@pytest.mark.parametrize(
    "change",
    [
        {"minSegmentMs": 0},
        {"maxSegmentMs": 999},
        {"paddingMs": 205},
        {"paddingMs": -10},
        {"mergeGapMs": 600},
        {"forcedSplitOverlapMs": 8000},
        {"minSegmentMs": 40000},
        {"extra": 1},
    ],
)
def test_segmentation_config_rules(change: dict[str, int]) -> None:
    from audio_service.contracts import PreprocessSegmentationConfig

    base = load(FIXTURES / "preprocess-config.segmented.valid.json")["segmentation"]
    PreprocessSegmentationConfig.model_validate(base)
    with pytest.raises(ValidationError):
        PreprocessSegmentationConfig.model_validate({**base, **change})


# -- review remediation: task deadline, RESOURCE_EXHAUSTED, Landlock scoping ---------------------

STATUS = {
    "taskId": "6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10",
    "type": "preprocess",
    "status": "running",
    "progress": None,
    "result": None,
    "error": None,
}


def test_task_status_deadline_is_optional_non_negative_integer_epoch_ms() -> None:
    TaskStatusResponse.model_validate(STATUS)  # older shape without the field
    TaskStatusResponse.model_validate({**STATUS, "deadlineAt": None})
    assert TaskStatusResponse.model_validate({**STATUS, "deadlineAt": 1795000000000}).deadlineAt
    for bad in (1.5, -1, "1795000000000", True):
        with pytest.raises(ValidationError):
            TaskStatusResponse.model_validate({**STATUS, "deadlineAt": bad})


def test_resource_exhausted_is_a_retryable_code_on_both_sides() -> None:
    from audio_service.domain.errors import is_retryable

    assert "RESOURCE_EXHAUSTED" in TS_CONTRACT.read_text()
    assert is_retryable(ErrorCode.RESOURCE_EXHAUSTED)
    body = {
        **STATUS,
        "status": "failed",
        "error": {"code": "RESOURCE_EXHAUSTED", "retryable": True},
    }
    TaskStatusResponse.model_validate(body)


def test_landlock_scoped_is_a_strict_boolean_with_a_false_default() -> None:
    caps = load(FIXTURES / "capabilities.valid.json")
    assert CapabilitiesResponse.model_validate(caps).landlock.scoped is False
    scoped = {**caps, "landlock": {**caps["landlock"], "scoped": True}}
    assert CapabilitiesResponse.model_validate(scoped).landlock.scoped is True
    with pytest.raises(ValidationError):
        CapabilitiesResponse.model_validate({**caps, "landlock": {**caps["landlock"], "scoped": 1}})


def test_tier1_wire_contract_is_bounded_and_finite() -> None:
    """Security review (Phase 3A M8): series length and quantity values are bounded/finite."""
    valid = load(FIXTURES / "measure-result.valid.json")
    long = json.loads(json.dumps(valid))
    long["series"]["speechMs"] = [0] * 200_001
    long["series"]["snrDb"] = [None] * 200_001
    with pytest.raises(ValidationError):
        MeasureResult.model_validate(long)
    nan = json.loads(json.dumps(valid))
    name = next(iter(nan["record"]["quantities"]))
    nan["record"]["quantities"][name]["value"] = float("nan")
    with pytest.raises(ValidationError):
        MeasureResult.model_validate(nan)
