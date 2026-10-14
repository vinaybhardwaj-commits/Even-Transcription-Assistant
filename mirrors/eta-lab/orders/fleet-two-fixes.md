# ORDER — two fixes, both small, both overdue — 20 Sep 08:45

## 1. `lib/admin-gate.ts` FAILS OPEN. Fix it.
You found it and left it alone, correctly, because it was outside your slice. It is now its own
slice and it is yours. When `ADMIN_TOKEN` is unset, the gate lets the caller through. That is the
exact fall-through I specified against for the new bearer, and it turns out the existing gate
already has it.

One caller: `app/api/admin/admins/route.ts`. Make an unset token mean REFUSE, never allow —
model it on `app/api/run-migrations/route.ts:123-125`. Test the unset case explicitly; that is
the case nobody writes and the only one that matters here.

Note the live `ADMIN_TOKEN` is a 13-character placeholder, so this is not theoretical.

## 2. The Docker volume leak. Fix the cause.
`tests/support/pg-harness.ts:30` and `:49`, and `tests/support/s1-pg.ts:99` and `:111` call
`docker rm -f` without `-v`, so every test run abandons the container's storage. 1,198 orphans on
19 Sep alone; 93 more appeared within 40 minutes of the prune this morning. It is why the disk
filled, and it is still running.

Change them to `docker rm -fv`. Then add a guard so it cannot come back: a test or a check that
fails if `docker rm -f` appears without `-v` anywhere under `tests/`. A one-word fix with no
guard is a fix that regresses.

## Both
Branch from `origin/vinay/s1-auto-drain` (head `6be6017`). Full suite. Do not push to
s1-auto-drain; I merge. Counts and timings only. Your `vinay/operator-token` branch stands as
built — I will take it when I set the token.
