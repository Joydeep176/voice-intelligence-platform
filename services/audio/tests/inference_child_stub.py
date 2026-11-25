"""Stand-in child for `isolation.run_isolated` tests: behaviour chosen by `config["stub"]`."""

import json
import os
import signal
import sys
import time

msg = json.loads(sys.argv[1])
mode = msg["request"]["config"]["stub"]


def emit(m: dict) -> None:
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


if mode == "ok":
    emit({"progress": {"stage": "transcribe", "fraction": 0.5, "processedMs": 1000}})
    data = os.pread(int(msg["fd"]), 64, 0)  # the inherited descriptor is readable
    emit({"result": {"bytes": len(data), "token": os.environ.get("AUDIO_SERVICE_TOKEN")}})
elif mode == "error":
    emit({"error": "STORAGE_ERROR"})
elif mode == "unknown-error":
    emit({"error": "NOT_A_CODE"})
elif mode == "sleep":
    time.sleep(30)
elif mode == "garbage":
    sys.stdout.write("not json\n")
    emit({"result": {"bytes": 0}})
elif mode == "flood":
    sys.stdout.write("x" * (17 * 1024 * 1024))
    sys.stdout.flush()
elif mode == "stdin":
    emit({"result": {"stdin": sys.stdin.read()}})
elif mode == "kill":
    os.kill(os.getpid(), signal.SIGKILL)
