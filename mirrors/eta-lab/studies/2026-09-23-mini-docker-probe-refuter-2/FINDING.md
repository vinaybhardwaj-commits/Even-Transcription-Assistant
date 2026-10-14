# Mini: "Docker is not available" for every postgres proof — diagnosis (eta-refuter-2, 23 Sep 2026)

Raised by ETA-Refuter (bus paste): `dockerAvailable()` (tests/support/s1-pg.ts:42, pg-harness.ts:21) is false
on the Mini after the Docker-to-E2E move, and c2-e2e-runner reports 1 failed / 54 skipped there. The Mini was
checked read-only: no context switched, nothing started or stopped.

## What the Mini actually has
- `~/.docker/config.json` has `"currentContext": "desktop-linux"`, not `e2e`. `kit/DOCKER.md` says `e2e`
  is the default. DOCKER_HOST and DOCKER_CONTEXT are both unset, so every plain `docker` call goes to Desktop.
- **Docker Desktop's backend is running** (`com.docker.backend` pids 36315/36321/36322; socket created 20:40).
  DOCKER.md says "Desktop is quit, autostart off". It isn't.
- `docker --context desktop-linux version --format {{.Server.Version}}`: **hangs**, killed at 20 s (rc 124).
  ETA-Refuter saw a 500 from the same socket. Either way, that endpoint is broken.
- `docker --context e2e version --format {{.Server.Version}}`: **rc 0, `29.8.1`**, in seconds.

## Verdict on the claim
- **The probe is right. The Mini's default Docker is broken.** `docker version` asks exactly the endpoint
  that every later `docker run`/`docker exec` in the suite would use. Swapping to `docker info` or
  `docker context inspect` queries the same broken socket, and the CLI already honours DOCKER_CONTEXT. Neither
  change fixes anything. `docker ps` "working" must have gone through `--context e2e`.
- **Fix = configuration, not code:** `docker context use e2e` on the Mini, and quit Desktop and turn off
  its autostart again, as DOCKER.md already says. This is shared config for every Mini pane, so it's Fable's
  or herdr-kit's call, not mine; I have not changed it. s1-pg drives postgres through `docker exec … psql`
  (s1-pg.ts:14), so the suites work over the ssh context, one ssh round trip per statement.
- **Correction to the contrast:** `attest-method-testimony.test.ts` does NOT skip silently. At d519d7b and on
  production `vinay/s1-auto-drain` it has the same loud guard (:47–50, "REQUIRED PROOF NOT RUN … or
  ETA_ALLOW_SKIP_E2E=1"). Its real hazard is the `git show vinay/attest-capture` residue (ledger 453–454).

## Real defects found on the way
- **D1 (medium, test support; ETA repo, owner of production tests):** `dockerAvailable()` calls
  `execFileSync` with **no timeout** (s1-pg.ts:43). On a socket that hangs (as measured here), every
  Docker-gated file hangs at module load. The gate stalls until the CI watchdog's 1800 s kill instead of
  failing in seconds. Fix: `timeout: 15_000`. Also split the message: "docker CLI absent" vs "docker present,
  server unreachable: <first stderr line>". Keep failing loudly for both. This is the absent-vs-broken
  split ETA-Refuter asked for, and it helps the message, not the verdict.
- **D2 (medium, kit):** once the Mini uses the e2e context, its test containers run ON THE BOX. The box
  CI's cleanup (`yoga-ci-remote.sh` :112 and :192–196) removes EVERY container that appeared during its run
  (`docker ps -aq` before/after diff, `docker rm -fv`), whoever created it. So a Mini or box-pane test run
  that overlaps a box CI run has its postgres killed at that CI run's end. Fix: sweep only containers
  whose name carries this run's `worktreeTag` (tests/support/container-name.ts already stamps it), or
  apply a `--label` per run and filter on it.

## Addendum (ETA-Refuter accepted both corrections: ledger 473)
- D2's fix should settle two questions at once: sweep by a per-run label or worktreeTag, AND remove volumes
  (`rm -fv`, or `--rm` plus anonymous volumes only). Test harnesses that do `rm -f` without `-v` orphan
  volumes (the known Docker volume-leak hazard). The box sweep already uses `-fv`; the test-side removals must match.
- **Rule (stated once, covering D1, host_is_free and dockerAvailable):** a capability probe must return
  three states, not one bit: ABSENT (the tool or host isn't there), BROKEN (present but the call failed; carry
  the first stderr line), and OK. Every probe needs a timeout. ABSENT and BROKEN both fail loudly with
  different messages, and neither may ever be stored or reported as "not needed" or "skipped".
