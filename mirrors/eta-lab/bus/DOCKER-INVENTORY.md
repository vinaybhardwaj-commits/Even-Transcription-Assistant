# Docker Desktop inventory (Mini) — before decommission

Taken 23 Sep 2026, ~20:45 IST, per orders/DOCKER-TO-E2E.md step 4. Docker
Desktop was started once for this inventory, then quit again; not set to
start at login.

## Images (all registry-sourced — none locally built, nothing to `docker
save | ssh e2e-lab docker load`)

| Image | Disk usage |
|---|---|
| alpine:3 | 13.6 MB |
| docker/labs-vscode-installer:0.0.9 | 54.9 MB |
| mcp/sequentialthinking@sha256:cd3174b2... | 233 MB |
| postgres:16 | 663 MB |

Re-pull on the box when needed (`docker pull <image>` — the box already has
`nvidia/cuda:12.4.1-base-ubuntu22.04` and `postgres:16` from CI runs).

## Containers

`docker ps -a`: empty. Nothing to migrate.

## Volumes

27 local volumes, all anonymous (hash names, not human-named), all `LINKS:
0` (no container currently references any of them), all ~40-44 MB each —
consistent with leftover MCP-gateway/devcontainer runtime scratch space
from past sessions, not identifiable persistent data. **Not copied to the
box** — nothing here looks like data worth migrating, and copying 27
orphaned ~41 MB blobs would just be dead weight. Left in place on the Mini
(not deleted, per "no deletion" — Docker.raw itself is untouched).

## The stale `~/docker-disk/vms-data` symlink

`/Users/vinaybhardwaj/docker-disk/vms-data` is a symlink to `/Volumes/Air
Drive/docker/vms-data` — that target directory does not exist (the real
data lives at `/Volumes/Air Drive/DockerDesktop/Docker.raw` instead, a
different path). The symlink predates whatever reorganized the external
SSD's `docker/` layout into `DockerDesktop/`. Left as-is, not deleted —
just noting it here so nobody chases a "missing" path later. `Docker.raw`
itself: 3.0 GB actual disk usage (sparse file; `ls -la` reports an inflated
~1.86 TB logical size, which is normal for a sparse disk image and not a
real 1.86 TB of usage).

## State after this inventory

Docker Desktop: quit (memory_pressure free % back to 62% after quitting,
from 36-37% while its VM was up). AutoStart was `true` in
`~/Library/Group Containers/group.com.docker/settings-store.json` (no CLI
toggle exists for this, `docker desktop disable` only covers
model-runner) — backed up that file
(`settings-store.json.bak-before-autostart-disable-23sep`) and flipped
`AutoStart` to `false` directly; confirmed it did not relaunch itself.
`docker` CLI on the Mini now defaults to context `e2e` (`ssh://e2e-lab`,
the box) — use `docker --context desktop-linux ...` if Docker Desktop is
ever started again for a one-off local need.
