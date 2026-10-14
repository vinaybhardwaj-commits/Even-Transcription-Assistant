# Order — Docker lives on the E2E box, not the Mini (23 Sep 19:25, Fable → herdr-kit; V asked)

## Goal
We have Docker whenever we need it, with zero Docker VM on the Mini: the engine runs on eta-lab-t4 (native Ubuntu, GPU-capable), and the Mini's `docker` CLI and Docker MCP gateway talk to it over SSH.

## Known facts
- Mini: Docker Desktop is quit (ruling #6, no Docker VM on the Mini). Its disk image is `/Volumes/Air Drive/DockerDesktop/Docker.raw` (3.0 GB). `~/docker-disk/vms-data` is a stale symlink to `/Volumes/Air Drive/docker/vms-data` (missing). `docker` is not on the Mini PATH; the CLI binaries are in /Applications/Docker.app/Contents/Resources/bin/.
- Docker MCP Toolkit on the Mini: profile `mini-claude` (sequentialthinking image + 2 remote servers), DB ~/.docker/mcp/mcp-toolkit.db; a `docker mcp gateway run --profile mini-claude` process is running.
- Box: Ubuntu 22.04.5, /usr/bin/docker present, NVIDIA driver 550.90.07, eta has passwordless sudo, 698 GB free.

## Steps
1. Box: make docker usable by eta without sudo (docker group), enable on boot; install/verify nvidia-container-toolkit so `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` works. Data root on / is fine (698 GB free). Log rotation for containers (json-file max-size 50m, max-file 3).
2. Mini: a standalone docker CLI on PATH (brew `docker` CLI only — NOT Docker Desktop), `docker context create e2e --docker host=ssh://e2e-lab` and `docker context use e2e`. Verify `docker ps` and the GPU run above from the Mini.
3. Point the Docker MCP gateway (profile mini-claude) at the e2e context; confirm the MCP_DOCKER tools work (sequentialthinking runs as a container on the box). Note: bind-mounts of Mini paths do not exist on the box — list any server that needs one as UNVERIFIED/unsupported.
4. Inventory of what was in the old Docker Desktop VM — ONLY AFTER 20:30 IST (clinic closed; Mini memory matters until then): start Docker Desktop once, `docker images` + `docker ps -a` + volumes into bus/DOCKER-INVENTORY.md; for any locally built image (no registry source) `docker save | ssh e2e-lab docker load`; for named volumes with data, copy to the box. Registry images: just note them (re-pull on the box when needed). Quit Docker Desktop and set it not to start at login. Do NOT delete Docker.raw — Fable asks V.
5. Fix the stale ~/docker-disk/vms-data symlink note in bus/DOCKER-INVENTORY.md (don't delete anything).

## Not allowed
No Docker VM left running on the Mini. No containers that bind to production ports on the Mini. No deletion of Docker.raw or images on the Mini. GPU: containers doing finite batch work take `flock /home/eta/gpu.lock`; long-running GPU servers must be declared in bus/DOCKER-INVENTORY.md.

## Output (≤10 lines via the bus)
What runs where, the verify commands' results, inventory summary, anything UNVERIFIED. Commit to eta-lab main.


## ADDENDUM 19:30 (V): Docker must be usable by ETA-Refuter and every other CC pane that needs it. Docker.raw stays (V: keep it).
6. Box panes (user eta): already-running Claude Code sessions will NOT pick up a new docker group membership. Also grant immediate access: setfacl -m u:eta:rw /var/run/docker.sock, made persistent with a systemd drop-in for docker.service (ExecStartPost setfacl) so it survives reboots. Verify from INSIDE a running box pane's Bash tool (e.g. ask diar-lab or lab-mover to run `docker ps`), not just a fresh ssh.
7. Mini panes (eta-refuter, fleet, herdr-kit, minibot): `docker context use e2e` is stored in ~/.docker/config.json, so every Mini pane's next Bash call gets it — verify from ETA-Refuter's pane with `docker ps` and the GPU nvidia-smi container. Docker CLI must be on the PATH those panes use (/opt/homebrew/bin).
8. Write kit/DOCKER.md (≤25 lines): where the engine is, how to use it from the Mini and from the box, the GPU flock rule, the "no Mini bind-mounts" limit, log rotation. Then hsend every pane one line: "Docker is available: see kit/DOCKER.md".
