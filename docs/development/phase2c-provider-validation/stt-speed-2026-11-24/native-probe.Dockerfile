# Scratch measurement image only (not part of the repo): pywhispercpp 1.5.1 rebuilt from source
# for the running CPU (DOTPROD / FP16), on top of the deployed runtime image.
FROM vip-audio-service
USER root
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git && rm -rf /var/lib/apt/lists/*
RUN /app/.venv/bin/python -m ensurepip \
 && CMAKE_ARGS="-DGGML_NATIVE=ON" /app/.venv/bin/python -m pip install --no-cache-dir \
    --no-binary pywhispercpp --force-reinstall --no-deps pywhispercpp==1.5.1
USER audiosvc
