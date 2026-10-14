# Worker host: e2e-c4 (primary), eta-lab-t4 (failover)

One worker runs at a time. The worker is the docker image built from the repo `Dockerfile`, run by a systemd `--user` unit. It reads palimpsest artefacts by ref through the REB bundle reader and keeps no copy: bodies live in memory only. Decision: worker-host decision, 13 Oct 2026.

## Reader source

| `NEWCAT_REB_SOURCE` | Where `python3 -m kit.reb.consult_bundle` runs | Paths |
|---|---|---|
| `local` (default) | inside the container | `NEWCAT_ETA_LAB_DIR=/eta-lab`, `NEWCAT_REB_ROOT=/reb` (read-only mounts, set by the unit) |
| `t4` | on t4, over `ssh` (argv array, `BatchMode=yes`, `ConnectTimeout=10`) | `NEWCAT_REB_SSH_LAB_DIR` and `NEWCAT_REB_SSH_ROOT` are paths on t4; `NEWCAT_REB_SSH_HOST` is an alias from `~/.ssh/config` in the mounted ssh directory |

With `t4`, the remote writes `--out` into a `mktemp -d` directory (0700) that it removes in the same command; only the JSON returns. The remote python runs under `timeout -k 5 15` (TERM at 15 s, KILL at 20 s; the worker's ssh timeout is 30 s with a 10 s connect), so the trap always runs. Each track body is read with `ssh host cat` after a `realpath -e` check on t4, hashed on the worker and refused on a sha mismatch. Nothing is written to local disk. R2 is W2, not here.

## Install (c4, after merge; newcat-lead)

1. Build and tag: `docker build -t newcat-worker:current .` (from the merged checkout).
2. Files, all owned by the service user:
   - `~/.config/newcat/worker.env` from `deploy/worker-c4/worker.env.example`, `chmod 600`. Values are copied by gating-lead; never paste them into git, chat or logs.
   - An eta-lab checkout that contains `kit/reb/consult_bundle.py` (commit `ae87516a` or later) and set `NEWCAT_HOST_LAB_DIR` to it.
   - `NEWCAT_HOST_REB_ROOT`: any existing directory. On c4 with `t4` it is unused, point it at an empty directory.
   - An ssh directory for `NEWCAT_HOST_SSH_DIR` holding `config` (Host alias, `HostName`, `User`, `IdentityFile`, `UserKnownHostsFile`, `StrictHostKeyChecking yes`), the private key (0600), and `known_hosts` with the t4 host key. The container user is `node` (uid 1000): the key file must be owned by uid 1000 on the host, or ssh refuses it.
3. `mkdir -p ~/.config/systemd/user && cp deploy/worker-c4/newcat-worker.service ~/.config/systemd/user/`
4. `loginctl enable-linger $USER` (the unit must survive logout), then `systemctl --user daemon-reload`.

## Start, stop, status

```bash
systemctl --user enable --now newcat-worker     # start (and at boot)
systemctl --user stop newcat-worker              # graceful: drains up to 30 s
systemctl --user restart newcat-worker
systemctl --user status newcat-worker
```

## Health check

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:43124/health   # 200 ok, 503 stale
curl -s http://127.0.0.1:43124/health
```

Body: `{ "status": "ok" | "stale", "jev": ..., "last_tick_age_s": <number> }`. No clinical data. Rule: the worker is stale (HTTP 503) when `last_tick_age_s` exceeds `3 x (WORKER_POLL_MS / 1000 + 600)` seconds, where 600 s is the lease budget; with the default 2 s poll that is 1806 s. A tick is one finished step of the poll loop. A job that outlasts that budget trips it, which is the point: its lease has expired.

## Logs

```bash
journalctl --user -u newcat-worker -f
journalctl --user -u newcat-worker --since '1 hour ago' | grep -E 'worker.heartbeat|reb.bundle_latency|artefact.reb_bundle'
```

- `worker.heartbeat` `{tick_age_s}` every `NEWCAT_HEARTBEAT_S` seconds (default 300).
- `reb.bundle_latency` `{reb_source, duration_ms, slots}` once per process, on the first successful bundle read.
- `artefact.reb_bundle` `{status, error_type}` per read. `error_type` values include `transport_failed` (ssh could not connect, exit 255), `spawn_failed` (no ssh/python3 binary or output overflow), `timeout`, `refused`, `nonzero_exit`, `parse_failed`, `track_unreadable`, `path_outside_root`.

Logs carry counts and codes only: no uid, path, quote or body.

## Failover runbook: c4 down, run on t4

The lease rule (docs/DEPLOY.md): a lease lasts 10 minutes and a second replica waits on row locks, but never rely on that: **stop one worker before starting the other.**

1. Stop c4's unit and confirm it is down before anything else. On c4: `systemctl --user disable --now newcat-worker`, then `systemctl --user is-active newcat-worker` must print `inactive` and `docker ps` must not list the worker. If c4 is unreachable you cannot confirm this: wait at least 10 minutes so any lease it held expires, then start t4. The c4 unit stays enabled (it starts again on c4 reboot or return), so the first thing done when c4 is reachable again is the `disable --now` above, before t4 keeps running alongside it. Never leave both running.
2. On t4, install the same image and unit as above. In t4's `worker.env` set `NEWCAT_REB_SOURCE=local`, `NEWCAT_HOST_LAB_DIR` to t4's eta-lab checkout, `NEWCAT_HOST_REB_ROOT` to the REB store (the unit mounts it read-only at `/reb`), and `NEWCAT_HOST_SSH_DIR` to any existing directory. The rest of the env is the same.
3. `systemctl --user enable --now newcat-worker`, then the health check and `grep reb.bundle_latency` (expect `"reb_source":"local"`).
4. Failback: `systemctl --user disable --now newcat-worker` on t4, confirm `is-active` prints `inactive`, and only then `systemctl --user enable --now newcat-worker` on c4 and repeat the health check.

t4 disk is 96% full: the unit writes only to a 256 MB tmpfs, so no host path is written.
