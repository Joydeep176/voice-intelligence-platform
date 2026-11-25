#!/bin/zsh
# NFR-7 bounded-memory evidence: 60-min diarization through the real service task (windowed, ADR-0037),
# production limits (768 MB, 2 CPUs, 2 threads, Landlock required). Samples cgroup anon at 10 Hz.
I=/private/tmp/claude-501/-Users-joydeepsingh-voice-intelligence-platform/7295e320-8e16-41f9-aa4e-b13fb94e4fb9/scratchpad/inference-check
L=$I/long; OUT=$L/long.log
echo "start $(date +%FT%T) image=$(docker image inspect -f '{{.Id}}' vip-audio-service)" > $OUT
docker rm -f vip-audio-long-check >/dev/null 2>&1
rm -rf $L/storage/derived && mkdir -p $L/storage/derived && chmod 777 $L/storage/derived
docker run -d --name vip-audio-long-check --init --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 768m --cpus 2 --tmpfs /tmp:size=16m,noexec,nosuid,nodev \
  -e AUDIO_SERVICE_TOKEN="$TOKEN" -e AUDIO_SERVICE_ENV=development -e AUDIO_SERVICE_STORAGE_ROOT=/storage \
  -e AUDIO_SERVICE_LANDLOCK=required -e AUDIO_SERVICE_MODELS_DIR=/models -e AUDIO_SERVICE_INFERENCE_THREADS=2 \
  -e OMP_NUM_THREADS=2 -v $L/storage/recordings:/storage/recordings:ro -v $L/storage/derived:/storage/derived \
  -v vip_audio-models:/models:ro -p 127.0.0.1:8012:8001 vip-audio-service >/dev/null
sleep 10
docker exec vip-audio-long-check sh -c 'm=0; while :; do a=$(awk "/^anon /{print \$2}" /sys/fs/cgroup/memory.stat); [ "$a" -gt "$m" ] && m=$a && echo $m > /tmp/anonmax; sleep 0.1; done' &
SAMPLER=$!
cd /Users/joydeepsingh/voice-intelligence-platform && uv run --directory services/audio python $L/check_long.py http://127.0.0.1:8012 "$TOKEN" $L/result-long.json > $L/result-long.stdout 2>&1
echo "check exit=$? $(date +%FT%T)" >> $OUT
docker exec vip-audio-long-check sh -c 'echo anon_max=$(cat /tmp/anonmax); echo peak=$(cat /sys/fs/cgroup/memory.peak); grep -E "^oom_kill " /sys/fs/cgroup/memory.events' >> $OUT
kill $SAMPLER 2>/dev/null
docker rm -f vip-audio-long-check >/dev/null 2>&1
echo "DONE $(date +%FT%T)" >> $OUT
