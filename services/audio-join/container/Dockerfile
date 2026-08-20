# services/audio-join/container/Dockerfile — the joining box.
#
# Small Linux + a statically-available ffmpeg, per the U2 kickoff. Alpine's ffmpeg package
# carries both ffmpeg and ffprobe with libopus and the Matroska/WebM muxer, which is the whole
# toolchain this service needs; nothing is fetched at run time.
#
# Cloudflare Containers run on linux/amd64. Build with:
#   docker build --platform linux/amd64 -t eta-audio-join ./services/audio-join/container
#
# NO CREDENTIAL LIVES HERE. The process never reads or writes storage and never reaches the
# network (the Worker sets enableInternet = false); it receives piece bytes on a socket from the
# Durable Object and hands the joined bytes back on the same socket.

FROM node:22-alpine

RUN apk add --no-cache ffmpeg \
 && ffmpeg -version \
 && ffprobe -version

WORKDIR /app

# No dependencies: the server is Node's own http + child_process.
COPY join-core.mjs server.mjs ./

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

# Non-root: the join needs nothing but /tmp.
USER node

CMD ["node", "server.mjs"]
