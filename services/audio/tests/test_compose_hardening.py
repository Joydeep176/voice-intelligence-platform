"""Container hardening as actually applied by Docker (ADR-0035, plan §6.2). Drives Docker from the
host; run with AUDIO_SERVICE_TEST_DOCKER=1. Uses a throwaway token and storage directory."""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess  # noqa: S404
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest

pytestmark = pytest.mark.docker_host

COMPOSE = next(  # the repository compose file (host only; the container has no repository)
    (
        p / "infra/docker/compose.yaml"
        for p in Path(__file__).resolve().parents
        if (p / "infra/docker/compose.yaml").exists()
    ),
    Path("compose.yaml"),
)
PROJECT = "vip-audio-hardening-test"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def docker(*args: str, env: dict[str, str] | None = None) -> str:
    return subprocess.run(  # noqa: S603
        ["docker", *args],  # noqa: S607
        check=True,
        capture_output=True,
        text=True,
        timeout=600,
        env={**os.environ, **(env or {})},
    ).stdout


@pytest.fixture(scope="module")
def stack(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[str, int, str]]:
    storage = tmp_path_factory.mktemp("storage")
    (storage / "recordings").mkdir()
    (storage / "derived").mkdir()
    storage.chmod(0o777)  # the container user (uid 10001) must be able to write `derived`
    (storage / "derived").chmod(0o777)
    port, token = free_port(), secrets.token_urlsafe(32)
    env = {
        "AUDIO_SERVICE_TOKEN": token,
        "AUDIO_SERVICE_PORT": str(port),
        "AUDIO_STORAGE_HOST_ROOT": str(storage),
        "POSTGRES_USER": "unused",
        "POSTGRES_PASSWORD": "unused",
        "POSTGRES_DB": "unused",  # interpolation only
    }
    base = ["compose", "-p", PROJECT, "-f", str(COMPOSE), "--profile", "audio"]
    try:
        docker(*base, "up", "-d", "--build", "--wait", "audio-service", env=env)
        container = docker(*base, "ps", "-q", "audio-service", env=env).strip()
        yield container, port, token
    finally:
        subprocess.run(
            ["docker", *base, "down", "-v", "--remove-orphans"],
            env={**os.environ, **env},
            check=False,
            timeout=120,
        )  # noqa: S603, S607


def inspect(container: str) -> dict:  # type: ignore[type-arg]
    return json.loads(docker("inspect", container))[0]


def test_capabilities_are_dropped_and_privilege_escalation_is_off(
    stack: tuple[str, int, str],
) -> None:
    host = inspect(stack[0])["HostConfig"]
    assert host["CapDrop"] == ["ALL"] and not host["CapAdd"]
    assert (
        "no-new-privileges:true" in host["SecurityOpt"]
        or "no-new-privileges" in host["SecurityOpt"]
    )
    assert host["PidsLimit"] == 64
    assert host["ReadonlyRootfs"] is True
    # 768 MB (ADR-0039) and 2 CPUs (ADR-0041)
    assert host["Memory"] == 768 * 1024 * 1024 and host["NanoCpus"] == 2_000_000_000
    assert {"noexec", "nosuid", "nodev", "size=16m"} <= set(host["Tmpfs"]["/tmp"].split(","))
    assert host["Privileged"] is False


def test_port_is_published_on_loopback_only(stack: tuple[str, int, str]) -> None:
    bindings = inspect(stack[0])["NetworkSettings"]["Ports"]["8001/tcp"]
    assert bindings and {b["HostIp"] for b in bindings} == {"127.0.0.1"}


def test_runs_on_a_user_defined_normal_bridge_network(stack: tuple[str, int, str]) -> None:
    networks = inspect(stack[0])["NetworkSettings"]["Networks"]
    assert list(networks) == [f"{PROJECT}_vip-audio-dev"] or all(
        "vip-audio-dev" in n for n in networks
    )
    net = json.loads(docker("network", "inspect", next(iter(networks))))[0]
    assert net["Driver"] == "bridge" and net["Internal"] is False
    assert "com.docker.network.bridge.enable_ip_masquerade" not in net["Options"]


def test_mounts_are_only_storage_and_the_read_only_models(stack: tuple[str, int, str]) -> None:
    mounts = {m["Destination"]: m["RW"] for m in inspect(stack[0])["Mounts"]}
    # /models: the pinned inference models, read-only (ADR-0036 / ADR-0037)
    assert mounts == {"/storage/recordings": False, "/storage/derived": True, "/models": False}


def test_service_requires_the_token_and_serves_liveness(stack: tuple[str, int, str]) -> None:
    _, port, token = stack
    base = f"http://127.0.0.1:{port}"
    assert urllib.request.urlopen(f"{base}/health/live", timeout=5).status == 200  # noqa: S310
    with pytest.raises(urllib.error.HTTPError) as info:
        urllib.request.urlopen(f"{base}/v1/capabilities", timeout=5)  # noqa: S310
    assert info.value.code == 401
    request = urllib.request.Request(
        f"{base}/v1/capabilities", headers={"authorization": f"Bearer {token}"}
    )  # noqa: S310
    body = json.loads(urllib.request.urlopen(request, timeout=5).read())  # noqa: S310
    assert body["ffmpeg"] is not None and body["python"].startswith("3.12")
    print(f"CAPABILITIES={json.dumps(body)}")  # noqa: T201


def test_container_logs_do_not_contain_the_token(stack: tuple[str, int, str]) -> None:
    container, port, token = stack
    time.sleep(0.5)
    logs = subprocess.run(
        ["docker", "logs", container], capture_output=True, text=True, check=True
    ).stdout  # noqa: S603, S607
    assert (
        token not in logs
        and token
        not in subprocess.run(["docker", "logs", container], capture_output=True, text=True).stderr
    )  # noqa: S603, S607


def test_service_refuses_to_start_with_a_short_token_and_names_only_the_variable(
    stack: tuple[str, int, str],
) -> None:
    image = inspect(stack[0])["Config"]["Image"]
    result = subprocess.run(
        ["docker", "run", "--rm", "-e", "AUDIO_SERVICE_TOKEN=short-value", image],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode != 0
    assert "AUDIO_SERVICE_TOKEN" in result.stderr and "short-value" not in result.stderr


def test_compose_requires_landlock_enforcement_for_media_children(
    stack: tuple[str, int, str],
) -> None:
    env = dict(e.split("=", 1) for e in inspect(stack[0])["Config"]["Env"])
    assert env["AUDIO_SERVICE_LANDLOCK"] == "required"


def test_readiness_follows_enforcement_and_capabilities_report_scoping(
    stack: tuple[str, int, str],
) -> None:
    """With `required`, ready (200) means Landlock was observed enforcing; otherwise 503 and the
    service refuses media children rather than run them unconfined. Liveness is up either way."""
    _, port, token = stack
    base = f"http://127.0.0.1:{port}"
    headers = {"authorization": f"Bearer {token}"}
    request = urllib.request.Request(f"{base}/v1/capabilities", headers=headers)
    landlock = json.loads(urllib.request.urlopen(request, timeout=5).read())["landlock"]  # noqa: S310
    print(f"COMPOSE_LANDLOCK={json.dumps(landlock)}")  # noqa: T201
    assert set(landlock) == {"supported", "abi", "enforced", "scoped"}
    assert landlock["scoped"] in (True, False)
    if landlock["scoped"]:
        assert landlock["enforced"] and landlock["abi"] >= 6
    ready = urllib.request.Request(f"{base}/health/ready", headers=headers)
    try:
        status = urllib.request.urlopen(ready, timeout=5).status  # noqa: S310
    except urllib.error.HTTPError as error:
        status = error.code
    assert status == (200 if landlock["enforced"] else 503)
    assert urllib.request.urlopen(f"{base}/health/live", timeout=5).status == 200  # noqa: S310
