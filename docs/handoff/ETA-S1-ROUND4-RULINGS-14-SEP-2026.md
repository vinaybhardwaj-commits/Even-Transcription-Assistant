# ETA — S1 ROUND 4 RULINGS
**14 September 2026 · Orchestrator · Rules the C9 contradiction, the FIX2 Refuter FAIL (H1–H5), and the manual-step change H2 forces.**

## 1. Two correct stops in a row, and both were mine to answer

`scribe` halted FIX3 rather than break a test it was not allowed to edit, and it **measured** before
halting — it removed the guard, ran the suite, and found exactly **1 of 48** tests depends on it. That
turns "these instructions conflict" into a precise question. `ETA-Refuter` failed FIX2 on a finding I would
never have looked for. Both are the process working; neither is a defect in the work.

## 2. C9 — RULED: option (b). Write the window row iff it would change.

The conflict: `c2-e2e-runner.test.ts:1351-1359` (IDEMPOTENT, ratified in C3) asserts a re-run for the same
diarize run does not rewrite the window row. C9 as I wrote it demanded a rewrite on every re-run.

**My phrasing was the error.** C9's goal was never "always rewrite" — it was **"never stale"**. Option (b)
delivers exactly that and reverses nothing:

> **Write the window row if and only if the state derived from the current segment rows differs from the
> state already stored.** A re-run that reproduces the same result writes nothing and IDEMPOTENT passes
> unedited. A re-run whose rows now say something different rewrites the window.

This covers `fail()` by the same rule and answers the Builder's question directly: on a settled `ok` window,
a re-run that fails partway **does** change the derived state, so it **does** write. No special case needed.

Rejected: **(a)** edits a ratified C3 test to satisfy a sentence I wrote carelessly — the test is not wrong.
**(c)** blocks manual re-scoring until a new diarize run, which removes an operator tool to fix a phrasing
bug. Accepted cost of (b): `attempts` and `scored_at` do not move on a re-run that reproduces the same
result. That is honest — nothing changed, so nothing is recorded as having changed. The job runner keeps
its own attempt counter, so no retry ceiling depends on the window's.

## 3. H1 — THE FAIL. The id guard can be walked past. FIX, and fix the class.

The guard deliberately skips untracked files under `docs/handoff/` so working papers don't trip it. The
Builder ran the gate at 09:36:59 and committed the FIX2 report at 09:37:17, so the guard never saw it —
and that report carries, on line 278, a placeholder in exactly the clinician-id shape the guard bans.
It is a placeholder, not a real id, so nothing leaked. **The report's claim that the gate results apply to
the committed tree is false, and any bus document committed after the gate escapes the same way.**

Ruling, both halves:
1. **The guard runs against the STAGED tree**, so nothing committed after it can escape. A guard whose
   scope is "untracked files are exempt" must run at the moment staging decides what is tracked.
2. **Replace the placeholder** with a form that cannot match the pattern — `doc_<id>`.
   A placeholder shaped like the thing it stands for will keep tripping every future scan.

## 4. H2 — migration 0092 can block the recording path. THE MANUAL STEP CHANGES.

`IF NOT EXISTS` makes 0092 safe to re-run but **not free**: Postgres takes an exclusive lock on
`bench_window` before it checks whether the column exists. If that ALTER queues behind an open transaction,
it blocks inserts on the chunk-upload path — the one path that must never stall, because it is a kiosk
waiting to hear its audio landed.

**Ruling: every ALTER in the manual step runs under a lock timeout, out of clinic hours.** The step V runs
becomes:

```
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0091_disable_gemini_stt_engine.sql
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0092_bench_window_auto_drain_refusal.sql
```

If it times out, it fails loudly and is re-run — which is safe, because both are idempotent. Failing beats
queueing in front of a recording room.

## 5. The rest of the Refuter's findings

**0091 cannot change routing — CORRECT AND INTENDED.** `resolveRouting` ignores `enabled` and fan-out
already had Gemini off. 0091 exists solely so `lib/mcp/tools/health.ts:116` stops counting a permanently
gated engine. It does that. No change.

**H3 — harness vs Neon divergences. Fix one, record two.** "A query starting with a comment or `(`
silently returns no rows" is a silent wrong answer and must **throw** instead. `bigint` coming back as a
number rather than a string, and row order not being guaranteed, are recorded as known divergences in a
comment at the top of the harness — nothing depends on them today, and a comment that names them will stop
the next person trusting the harness too far.

**H4 — the admin-cookie success test mocks both the cookie read and the JWT check. FIX.** It proves the
route calls its helpers, not that the door opens — testing rule 3. It guards the manual door to a route
that spends. Mint a real token with the repo's own signing path and let `verifyAdminJwt` verify it.

**H5 — the zero-scored retry tests depend on execution order. FIX.** Each seeds its own state. A test that
passes only in order hides state leakage and fails mysteriously the day the file is split.

## 6. ⚠️ WATCH — the Mini is swapping hard, and it may invalidate M2

M3 is still running and has already reported, in passing, that **the Mini is short of memory while idle**:
24 GB physical, **swap 20.5 GB used of 21.5 GB, ~85 MB of pages free**. It also found that `ps` RSS
understated M2's figures — port 8081 is a Python shim, and the real whisper-server is a separate process at
~1.87 GB actual against 6 MB RSS. And the shim's log carries a timestamp **after M2 finished**, which
suggests something other than the router was calling whisper.

Three consequences, none ruled until M3 reports:
- M2's 0.326 was measured on a swapping machine, and possibly with an uninvited whisper caller. It may be
  pessimistic, optimistic, or simply noisy. **Do not treat it as settled.**
- The shim waits at most 120 s for whisper-server, so a 900 s whisper-alone call may not complete at all.
  M3 will report that as a failure rather than substituting a direct call — correct.
- Concurrency headroom on a machine with 85 MB free is probably zero, whatever the CPU says.

This does not block FIX3b. It does block any decision about the cap, the backlog, or turning the flag on.


---

## 7. CORRECTION to §6, measured 14 Sep ~10:00 IST — the memory alarm was a misread metric

§6 above reported the Mini as "short of memory while idle" on the strength of ~85 MB of free pages. That
figure came from `vm_stat`'s **Pages free**, which on macOS is close to zero almost always, because the
kernel keeps everything it can as cache. It is not a pressure signal. Measured directly:

| Reading | Value |
|---|---|
| Disk available | **126 GB** on both volumes — swap has all the room it needs |
| `sysctl vm.swapusage` | total 19456 M, used 18349 M, free 1106 M (total shrank from 21504 M — macOS resizes it) |
| `memory_pressure` | **System-wide memory free percentage: 69%** |
| Physical | 24 GB (`hw.memsize` 25769803776) |

**The machine is not in distress now.** High swap-used alongside low current pressure means pressure
happened earlier and the evicted pages simply have not been faulted back.

### What caused it, and why it matters

`GET /api/ps` on ollama: **`qwen2.5:14b`, 11,551,516,672 bytes — 11.5 GB, all of it `size_vram`**, with
`expires_at` 10:05:29. On Apple Silicon that is unified memory: it is real RAM, and the ollama *process*
shows only 1773 M RSS, so `ps` understates it by ~10 GB — the same trap M3 already found for
whisper-server (1897 M actual against 6 MB RSS).

Top resident at the time of this reading summed to ~34 GB on a 24 GB machine: two Pythons at 8611 M and
7306 M, a Virtualization-framework VM at 7969 M, indic 2754 M, sravaani 2497 M, whisper-server 1897 M,
ollama 1773 M (+11.5 GB unified), another Python 1514 M.

**Ollama loaded that 11.5 GB model because M2 ran `translate=true`.** So:

1. **M2's numbers were taken across a memory event of our own making.** The `translate=false` runs (0.326)
   preceded the load; the `translate=true` run (0.342) caused it. That the two differ by less than
   run-to-run spread is now more interesting, not less — but M2 stands as the best figure we have.
2. **Translation is the expensive thing on this box, and it is the thing we need least.** It cost nothing
   measurable in wall time, and M2 showed 30 of 32 segments came back English anyway. Dropping it, or
   making the model load per-window and unload after, returns ~11.5 GB — which is the concurrency headroom
   question answered before M3 finishes asking it.
3. **`ps` RSS is not a memory measurement on this machine.** Neither is `vm_stat` Pages free. Use
   `memory_pressure` for pressure, `top`'s MEM column for a process, and the service's own API for a model.

### Consequence for the rulings above

§6 said the swap reading blocks the cap, the backlog and the flag. **It does not.** What still blocks them
is M3's actual result — whisper-alone versus route, and the concurrency figure — plus the unexplained
whisper caller at 09:46. Nothing about disk or swap is in the way.
