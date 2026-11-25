"""Responsiveness check of the deployed image under real inference (throwaway container, own token).

Usage: check.py <base_url> <token> <out_json>
Runs preprocess and diarize only (windowed above 10 min) on recordings/WS/REC/original,
polling /health/live every 0.5 s in a background thread. Prints only metrics and counts (no text).
"""

import json
import sys
import threading
import time
import urllib.error
import urllib.request

from audio_service.contracts import config_hash

BASE, TOKEN, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
WS = "11111111-1111-4111-8111-111111111111"
REC = "22222222-2222-4222-8222-222222222222"
FIX = "/Users/joydeepsingh/voice-intelligence-platform/packages/contracts/fixtures/audio-service/"


def call(method, path, body=None, timeout=10):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


live = {"n": 0, "max_s": 0.0, "fail": 0, "over_1s": 0, "lat": []}
status_lat = []
stop = threading.Event()


def poll_live():
    while not stop.is_set():
        t = time.monotonic()
        try:
            urllib.request.urlopen(BASE + "/health/live", timeout=10).read()
            d = time.monotonic() - t
            live["n"] += 1
            live["lat"].append(d)
            live["max_s"] = max(live["max_s"], d)
            live["over_1s"] += d > 1
        except Exception:  # noqa: BLE001
            live["fail"] += 1
        time.sleep(0.5)


def run_task(kind, config, key):
    prefix_cfg = PRE_CFG
    body = {
        "contractVersion": "2",
        "type": kind,
        "idempotencyKey": key,
        "workspaceId": WS,
        "recordingId": REC,
        "input": {
            "originalKey": f"recordings/{WS}/{REC}/original",
            "outputPrefix": f"derived/{WS}/{REC}/{config_hash(prefix_cfg)}",
        },
        "config": config,
    }
    started = time.monotonic()
    task = call("POST", "/v1/tasks", body)
    while True:
        t = time.monotonic()
        st = call("GET", f"/v1/tasks/{task['taskId']}")
        status_lat.append(time.monotonic() - t)
        if st["status"] in ("succeeded", "failed", "cancelled"):
            return st, time.monotonic() - started
        time.sleep(1)


caps = call("GET", "/v1/capabilities")
PRE_CFG = json.load(open(FIX + "preprocess-config.valid.json"))
PRE_CFG["toolVersions"] = {
    "service": caps["serviceVersion"],
    "python": caps["python"],
    "ffmpeg": caps["ffmpeg"]["version"],
    "numpy": caps["numpy"],
    "vad": caps["vad"],
}
report = {"taskTypes": caps["taskTypes"], "landlock": caps["landlock"], "tasks": []}
threading.Thread(target=poll_live, daemon=True).start()

st, wall = run_task("preprocess", PRE_CFG, "check-pre-0001")
assert st["status"] == "succeeded", st.get("error")
duration = st["result"]["canonical"]["durationMs"] if "canonical" in st["result"] else None
if duration is None:  # locate the duration field without printing content
    duration = next(v for k, v in st["result"].items() if k.lower().endswith("durationms"))
duration = int(round(duration))
report["tasks"].append({"type": "preprocess", "status": st["status"], "wall_s": round(wall, 2)})

dcfg = json.load(open(FIX + "diarize-config.valid.json"))
dcfg["audioDurationMs"] = duration
st, wall = run_task("diarize", dcfg, "check-di-0001")
res = st.get("result") or {}
report["tasks"].append(
    {
        "type": "diarize",
        "status": st["status"],
        "error": st.get("error"),
        "wall_s": round(wall, 2),
        "rtf": round(wall / (duration / 1000), 3),
        "speakers": res.get("speakerCount"),
        "turns": len(res.get("turns", [])),
    }
)
stop.set()
lat = sorted(live.pop("lat"))
live["p50_s"] = round(lat[len(lat) // 2], 4) if lat else None
live["p99_s"] = round(lat[int(len(lat) * 0.99)], 4) if lat else None
live["max_s"] = round(live["max_s"], 4)
report["live"] = live
report["status_poll_max_s"] = round(max(status_lat), 4)
report["durationMs"] = duration
json.dump(report, open(OUT, "w"), indent=1)
print(json.dumps(report, indent=1))
