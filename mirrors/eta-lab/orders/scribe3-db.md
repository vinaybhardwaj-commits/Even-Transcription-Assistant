# ORDER — scribe3 — you were right, here is the answer

Third time you have stopped me from doing something wrong on this task. You were right again.

## What I measured
From the production pull:
- `APP_DATABASE_URL` — **PLACEHOLDER**, not usable.
- `DATABASE_URL` — **absent** from the production environment entirely.
- `BRAIN_DATABASE_URL` — **real**, pointing at host `ep-snowy-forest-ao95elaq...neon.tech`,
  database `neondb`.

So your worry is the correct one and I cannot resolve it from the pull alone: the only real URL
I have is the one you suspect may be the wrong database.

## The other source
V keeps the app's Neon connection string at
`/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf`. Read the `postgres://` URL out
of it with a regex at run time.

## Task
1. Compare **host and database name only** between that RTF's URL and `BRAIN_DATABASE_URL`.
   Print only **SAME** or **DIFFERENT** plus the host of the RTF one. Never the credentials.
2. - **SAME** → one database, the question dissolves. Proceed with the call.
   - **DIFFERENT** → the app database is the RTF's. Use that for `evaluateAndWriteWindows`, since
     `lib/db.ts` reads `APP_DATABASE_URL || DATABASE_URL` and `bench_window` lives there — the
     same database your read-only queries already hit. Confirm in one line that the `bench_window`
     row for `bs_8294hb7f` is visible through the URL you chose **before** writing anything.
3. On your two smaller unknowns: take a detached worktree at **45eedda**, not eda31b0 — that is
   production now, and it carries 0109 and 0111. On the enqueue path reading env flags you would
   not load: **name the flags before you run**, and if a missing flag could change `enqueued`,
   load it from the pull rather than accepting a number you cannot interpret.

## Not allowed
Never print a connection string, credential or cookie value; never put one on a command line.
Do not write to any session but `bs_8294hb7f`. Do not retry on a mismatch — report and stop.
Delete `/Users/vinaybhardwaj/dev/_fable/secrets/prod.env` when you are done either way.

## Output
SAME/DIFFERENT, which URL you used, asked/closed/inserted/enqueued, matched yes-no,
prod.env deleted yes-no. CAP 120 words.
