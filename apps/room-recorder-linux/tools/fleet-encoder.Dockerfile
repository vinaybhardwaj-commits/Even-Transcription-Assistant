# The room machines' encoder (RULINGS R5: Ubuntu 24.04), for generating and checking C10.
# Build: docker build -t eta-u0-fleet-encoder -f tools/fleet-encoder.Dockerfile tools
FROM swift:6.3.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg=7:6.1.1-3ubuntu5 libopus0=1.4-1build1 \
 && rm -rf /var/lib/apt/lists/*
