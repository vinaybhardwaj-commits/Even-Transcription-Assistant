# Timbre scale runner for a Hugging Face Job / Space or a plain GPU VM.
#
# Build from this directory so the rest of the repo is not in the image:
#   docker build -f Dockerfile -t timbre-scale tools/timbre
#
# The default base already contains CUDA torch. A CPU image is only for a
# dry-run:
#   docker build --build-arg BASE_IMAGE=python:3.11-slim-bookworm -t timbre-scale tools/timbre
#
# HF_TOKEN and R2 credentials are runtime environment variables. This file
# does not set them.

ARG BASE_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    PYTHONPATH=/app

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-fast.txt requirements-docker.txt ./
RUN pip install --no-cache-dir -r requirements-docker.txt

COPY . /app/tools/timbre

ENTRYPOINT ["python", "-m", "tools.timbre.entrypoint"]
