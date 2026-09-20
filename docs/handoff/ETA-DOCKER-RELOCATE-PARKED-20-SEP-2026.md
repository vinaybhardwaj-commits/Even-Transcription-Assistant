# Docker disk image → Air Drive: PARKED, with the cause finally measured (20 Sep 2026)

**Status:** parked by V's decision, to be resumed later. Not abandoned.
**Why it is parked:** the problem it was going to solve is already solved by other means.
**Why this file exists:** four attempts have now failed. Nobody should spend a fifth one
rediscovering the first four.

## The cause, measured rather than inferred

`tmutil addexclusion` takes **11.038 seconds** on this machine.
`tmutil isexcluded` on the same path takes **0.17 seconds**.

Docker Desktop calls `addexclusion` when you set a new disk-image location. It waits on that
call, and the window looks frozen. Every previous diagnosis blamed Docker; Docker is not the
problem. Measured with a throwaway directory, with no backup running, so it is not contention.

### Why the call is slow
The Time Machine destination is a **network SMB share at 88% full**
(`smb://…/TimeMachineBackup`, 3.6 TiB total, 449 GiB free). Every exclusion WRITE has to reach it.
This also explains `backupd` sessions running 8+ hours.

Note `/Volumes/Air Drive` and `/Volumes/Air Drive/docker/vms-data` are **already excluded**, so
pre-excluding the target does NOT avoid the cost — the call is slow regardless of the answer.

## The untried step, for whoever resumes this

Turn OFF "Back Up Automatically" (System Settings → General → Time Machine) **before** the
relocate, then turn it back on after. None of the four attempts did this, because all four
assumed the fault was in Docker.

Full sequence:
1. System Settings → General → Time Machine → Back Up Automatically OFF.
2. Quit Docker Desktop fully (menu bar → Quit).
3. Docker Desktop → Settings → Resources → Advanced → Disk image location →
   `/Volumes/Air Drive/docker/vms-data` → Apply & Restart.
4. Verify: `docker version` answers, `docker run --rm postgres:16 true` succeeds,
   and `settings-store.json` finally carries a disk/data path key (today it carries none —
   that absence is how you know a relocate did not take).
5. Time Machine back ON.
6. Only then remove the internal `Docker.raw`.

## What has already been tried and does NOT work
Documented in `/Volumes/Air Drive/docker/README.md` (17 Sep) plus today:
1. Move + symlink to the external volume — the virtualization process never spawns.
2. `DataFolder` in `settings-store.json` — tmutil hangs.
3. `DiskPath` key — unknown to settings-store on 4.91.
4. GUI relocate (20 Sep, twice) — stalls on the 11 s `addexclusion`.

## State left behind, deliberately
- `/Volumes/Air Drive/docker/vms-data/Docker.raw.stale-17sep-20260920-0638` — the 17 Sep cold
  mirror, **renamed out of the way**. If it is left named `Docker.raw`, a future relocate will
  ADOPT it and silently restore that day's state. Leave it renamed until the move succeeds, then
  delete it.
- Live image remains at
  `~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw` (4.2 GB allocated,
  494 GB logical, sparse).

## Why it stopped being urgent
The disk pressure that motivated the move is gone: **62 GiB free**, down from 5 GiB, after
pruning 1,519 orphaned volumes holding 62.4 GB. The volumes came from our own test harnesses
calling `docker rm -f` without `-v` — 1,198 created on 19 Sep alone — in
`tests/support/pg-harness.ts` and `tests/support/s1-pg.ts`. **Fixing that one flag is the real
fix**; relocating would only have given the leak a larger bucket.

## The separate problem this uncovered — worth its own slice
Time Machine backs up to a network share at 88% full, sessions run 8+ hours, and the internal
Docker VM directory is `[Included]`, so a 494 GB logical sparse image is in scope for backup over
SMB. Nobody has verified those backups actually complete. The Mini holds the clinic's recordings
and this build. That question outranks where Docker keeps its scratch file.
