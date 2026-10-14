# AMENDMENT to your order — yoga-drain — 20 Sep 06:35 IST

Read this before you prune. I gave you an order on an assumption I had not checked, and having
now read `/Volumes/Air Drive/docker/README.md` (written 17 Sep) I need to correct the picture.

## What is actually true about Docker on this box

- The LIVE Docker disk image is on the INTERNAL SSD, at
  `~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw` — a sparse file that was
  ~6.4 GB allocated against ~460 GB logical on 17 Sep.
- The copy on Air Drive (`/Volumes/Air Drive/docker/vms-data/Docker.raw`) is a COLD MIRROR, not
  the live image. Docker is not running from Air Drive.
- Three attempts to relocate it have already failed and are documented: symlink (the
  virtualization process never spawns), `DataFolder` in settings-store (tmutil hangs), and the
  `DiskPath` key (unknown to settings-store on 4.91). Do not retry any of those.

## What that means for your prune

The good news: your 62.4 GB of orphaned volumes ARE on the internal disk, so pruning them is the
right action and my order stands. Note the arithmetic, because it is the whole story — that image
was 6.4 GB allocated on 17 Sep and now holds 62.4 GB of orphans, with 1,198 created on 19 Sep
alone. Three days of test harnesses calling `docker rm -f` without `-v` is what filled this
machine.

The trap, which I should have flagged first time: pruning volumes inside a SPARSE disk image
frees the space INSIDE the image. macOS will not necessarily hand that space back to the
filesystem. So you may prune 62 GB and see `df` barely move.

**If that happens, it is not a failed prune and it is not your error.** Report the two numbers
separately and plainly:
- how much Docker itself says was reclaimed, and
- whether the host filesystem's free space actually changed.

Then stop. Do not go hunting for a way to compact the image, and do not retry the relocate — the
README says the only method that works is the Docker Desktop GUI, which needs a human, and I am
putting that in front of V rather than having you attempt it.

## Order of operations, revised

1. `docker ps` first; confirm nothing is running that owns a volume you are about to remove.
2. Prune. Report reclaimed-by-Docker AND host free space, before and after.
3. Run the load test regardless of whether the space came back. I previously said to prune first
   because it would change the memory picture the test runs against — that was wrong. Docker
   volumes do not touch swap, and the 412 MB of free swap has nothing to do with them. Do not
   read the prune as a prerequisite for a valid measurement.
4. Everything else in the original order stands, including leaving `ETA_MAX_INFLIGHT` at 1 when
   you finish.

## One more thing worth knowing

`Docker.raw` is 494 GB logical. On a boot volume with about 5 GiB free, the fact that it is
sparse is the only reason this machine is still running. That is a standing fragility, not a
tonight problem — note it in your report and move on.
