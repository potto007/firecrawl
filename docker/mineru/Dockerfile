# docker/mineru/Dockerfile
FROM vllm/vllm-openai:v0.11.2

RUN apt-get update && \
    apt-get install -y \
    fonts-noto-core \
    fonts-noto-cjk \
    fontconfig \
    libgl1 && \
    fc-cache -fv && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install -U 'mineru[core]>=3.0.0' --break-system-packages && \
    python3 -m pip cache purge

# Lazy-lifecycle gate: owns the public port and reverse-proxies to a locally
# managed mineru-api child, killing it (and freeing the ~20GB vLLM GPU pool)
# after MINERU_IDLE_TIMEOUT seconds idle so the card is free for the teacher.
# Deps (httpx / starlette / uvicorn) are already present in the vllm base image.
COPY docker/mineru/lifecycle.py docker/mineru/entrypoint.py /opt/mineru-gate/
ENTRYPOINT ["python3", "/opt/mineru-gate/entrypoint.py"]
