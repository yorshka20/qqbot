FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

SHELL ["/bin/bash", "-c"]

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 安装 ComfyUI 依赖（从 volume 里的 requirements.txt 对应版本）
RUN pip install --no-cache-dir \
    comfyui-frontend-package==1.35.9 \
    comfyui-workflow-templates \
    comfyui-embedded-docs \
    torchsde \
    torchvision \
    torchaudio \
    numpy>=1.25.0 \
    einops \
    "transformers>=4.50.3" \
    "tokenizers>=0.13.3" \
    sentencepiece \
    "safetensors>=0.4.2" \
    "aiohttp>=3.11.8" \
    "yarl>=1.18.0" \
    pyyaml \
    Pillow \
    scipy \
    tqdm \
    psutil \
    spandrel \
    kornia \
    av

# 安装 custom_nodes 的常见依赖
RUN pip install --no-cache-dir \
    runpod \
    websocket-client \
    requests

# worker handler
COPY handler.py /handler.py
COPY extra_model_paths.yaml /extra_model_paths.yaml

CMD ["python3", "-u", "/handler.py"]
