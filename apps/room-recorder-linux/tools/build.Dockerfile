# Binding build image from U1 step 3 (ruling: link alsa-lib dynamically). swift:6.3.3 (Ubuntu 24.04.4) + ALSA headers.
# Build: docker build -t eta-u1-build -f tools/build.Dockerfile tools
# Use:   docker run --rm -v /home/vinay/dev/room-recorder-linux:/w -w /w eta-u1-build swift build -c release --static-swift-stdlib
FROM swift:6.3.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends libasound2-dev \
 && rm -rf /var/lib/apt/lists/*
