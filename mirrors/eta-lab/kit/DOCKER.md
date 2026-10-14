# Docker

Engine lives on the E2E box (`eta-lab-t4`), GPU-capable. No Docker VM on
the Mini — Desktop is quit, autostart off (see `bus/DOCKER-INVENTORY.md`).

## From the Mini
Standalone `docker` CLI on PATH (brew, not Desktop). Context `e2e`
(`ssh://e2e-lab`) is default — every command runs on the box over SSH:
```
docker ps
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```
`~/.docker/config.json` is shared, so a pane's next Bash call picks up
`e2e` immediately. A `docker mcp gateway` subprocess already running
before the switch needs restarting to see it — it won't re-read live.

## From the box
`docker` works directly (eta: docker group + a socket ACL for sessions
that predate the group add; both survive `systemctl restart docker`).

## Rules
- GPU: batch work takes `flock /home/eta/gpu.lock`; long-running GPU
  servers go in `bus/DOCKER-INVENTORY.md`.
- No Mini bind-mounts on the box — a server needing one is UNVERIFIED here.
- Logs: json-file, max-size 50m, max-file 3.
- Volumes: postgres:16 declares an anonymous VOLUME, which neither `-f`
  nor `--rm` reliably takes with it (fixed upstream in ETA's own test
  harness 20 Sep, `docker rm -fv` — a branch that predates that fix will
  still leak). `docker volume ls -q -f dangling=true | xargs -r docker
  volume rm` periodically; every pane runs Docker-backed suites here now.
