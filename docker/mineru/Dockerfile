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
