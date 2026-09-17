# A bare Ubuntu 26.04 with systemd as PID 1, for proving deploy/room-recorder-install.sh end to end without a real room
# machine. Deliberately nothing else: the installer must fetch its own packages (python3 is NOT here either, so the
# installer's no-python path is the one exercised).
FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
