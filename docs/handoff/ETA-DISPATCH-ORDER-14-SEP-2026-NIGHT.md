# ETA — dispatch order for the night · 14 Sep 2026, 21:10 · Orchestrator

Six specs are written and ready. This says what fires when, what must never run beside what, and who
owns which migration number. **Read this before dispatching anything.**

## 1. THE SIX

| # | Spec | Touches | Depends on |
|---|---|---|---|
| **E16** | emotion scores must mean something | `lib/emotion/*`, planner, store | — |
| **E17** | the drain must not starve a room | `lib/stt/auto-drain.ts` | — |
| **E18** | silent-window housekeeping | `diarize-job.ts`, `room-reads.ts`, `room-drain.ts` | **E11 merged** |
| **E19** | one classifier for a Whisper result | `bench.ts`, `transcribe-range.ts`, `room-drain.ts` | **E11 merged incl. (d)**, and **E18 finished** |
| **E20** | record the score that lost | `room_turn_speaker` writer | — |
| **E21** | native recorder audio levels | `apps/room-recorder/` (Swift) | — |

## 2. COLLISIONS — the only hard rule

> **E18 and E19 both edit `room-drain.ts`. They must never run at the same time. E18 first, then E19.**

Everything else is file-disjoint and may run in parallel. **Never two agents editing one file** —
that rule has not been broken today and tonight is not the night.

## 3. MIGRATION NUMBERS — reserved now, so two rounds cannot collide

Applied through **0093**. Reserved:

| number | owner | status |
|---|---|---|
| **0094** | E1 `voice_centroid` | reserved, **not being built tonight** — do not take it |
| **0095** | E18 `silent_window` | |
| **0096** | E20 losing score | |
| **0097** | E16 `speech_ms`, if it needs one | |
| **0098** | E17 last-served, if it needs one | |

Each spec says "check `schema_migrations` first". **That is still true and this table does not replace
it** — it removes the race between two rounds picking the same free number at the same moment. If a
round does not need a migration, its number stays free for the next one; say so in the report.

## 4. TONIGHT'S WAVES

**Wave 1 — now.** Three panes, three roles, no file overlap.

- `ETA-Refuter` → **refute E11's pre-merge commit.** This is the gate; nothing merges until it reports.
  It reviews its own specification being met — it wrote (a), (b) and (d) — not its own code.
- `scribe` → **E16**, once it has finished committing and pushing E11. The biggest and most valuable of
  the six, and scribe is warm on the emotion context.
- `scribe3` → **E17**. Isolated in `auto-drain.ts`, and it has the E4/E6 simulation already in hand as
  the acceptance test.

**Wave 2 — after E11 merges.** `E18`, then `E19`. Sequential, same file.

**Wave 3 — any time, isolated.** `E20` and `E21`. E21 must clear `apps/room-recorder/.build` first
(the `TestingMacros` failure from tonight).

## 5. STANDING CONSTRAINTS FOR EVERY ROUND TONIGHT

- **`ROOM_AUTO_DRAIN_ENABLED` stays `0`.** No round may turn it on. Clinic opens in the morning.
- **Nothing deploys.** Commit on green; push only when I say; merge only after a Refuter pass.
- **No round touches `app.py` or restarts a Mini service.** Emotion is live and working through its
  queue; that is deliberate and the jobs it finishes are evidence.
- **No transcript text, speaker names or clinical content in any report.** Counts, timings, ids, labels
  and error strings only.
- **Docker is down**; the four REQUIRED PROOF suites cannot run. Name them as unrun rather than
  reporting green (rule 8). The Mini is tight on memory — 20% free of 24 GB, ollama at 9.6 GB — so do
  not start Docker to get around it.
- **The mutation check is mandatory** in every build round, with the count reported. Rule 14: say which
  two behaviours each mutation separates.
- Neon string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf` — read it, use it,
  never print it, never copy it into the repo. `CREATE TEMP VIEW` fails read-only; inline as a CTE.
- The Tailscale bridge caps at ~60 s regardless of timeout and eats `cd` and some pipes: one
  `/usr/bin/python3 - <<'PY'` heredoc, absolute paths, never `$HOME`.

## 6. WHAT I AM HOLDING BACK, AND WHY

- **The threshold unification (R-F3a).** Needs E20's distribution first. Setting three thresholds from
  a handful of rows produced by single-sample centroids would be picking a number by feel, which is the
  thing the exercise exists to avoid.
- **The turn-bounds problem** — Whisper's timestamp mapping, why a 29 s turn holds 2 s of speech. Two
  stages upstream of emotion, affects more than emotion, and it deserves a proper investigation rather
  than a corner of E16.
- **The service contract** (`app.py` returning an explicit unscorable outcome, and carrying a version).
  Separate ask against an unversioned service outside this repo.
- **The dead-mic alarm.** E21 records the number; deciding what raises an alert and to whom is a
  clinical-operations decision.
- **The 1,442-window backlog.** V's call: process or archive.
- **The emotion cap (R3′).** Cannot be derived until scoring means something. E16 first.

## 7. THE ONE THING TO WATCH

E16 is the round where getting it wrong is worse than not doing it. A fix that improves the failure
count without fixing what a *success* means would give us a full table of confident, meaningless
clinical labels. **If E16 comes back reporting a better failure rate and nothing about speech fraction,
it has built the wrong thing** — send it back rather than merging it.

Orchestrator.

---

## 8. ADDENDUM — E11 pre-merge landed, and E19's apparent circularity resolved

**`ccd12b0` is pushed** (`6e68462..ccd12b0`), not merged, no PR. Four items in, **20 of 20 mutations
caught**, each applied by exact string and restored with a sha256 match. The strongest results:
`!full.ok` fails **18** tests, the substring mutation fails **7** — including the real client's
`500, body empty_transcript` and `200, body is not JSON` — and every one of the six sweep evasions
fails the sweep test.

**F3 needs a ruling before E19 starts, because it looks circular and is not.**

`scribe` reports the rebuilt sweep still has blind spots — it counts text rather than calls, and a
reader that string-joins a URL or reaches Whisper through a new wrapper importing none of the five
signals would pass — and says "the ruled shared-classifier round is what closes these." Read quickly,
that reads as: E19 is safe because of the sweep, and the sweep is complete because of E19.

**It is not circular, and the distinction is worth stating once so nobody stalls on it later:**

- **For performing the refactor**, the sweep is sufficient. The 20 classified entries and the matching
  behavioural rows tell us every call site that exists *today*, which is all E19 needs in order to move
  them onto a classifier without missing one.
- **For preventing the next divergence**, the sweep is insufficient, and that is precisely what E19
  fixes. After E19 the sweep's assertion changes from "every caller is classified" — a list someone
  must maintain — to **"every read of `.error` goes through the classifier"**, which is a structural
  property and strictly stronger.

> **The sweep is enough to make E19 safe to do. It is not enough to make E19 unnecessary.**

So E19 proceeds as specified when Wave 2 reaches it. Its V2 stands: demonstrate the assertion by adding
a bypassing call site, watching it fail, and removing it.

**F2 is the right call and should not be "fixed".** The real client cannot emit an error that *starts*
with the constant, so `startsWith` cannot be killed from real output alone; the near-misses are
constructed and labelled as constructed in the file. That is the honest version of the Refuter's
demand, not a shortcut around it.

**Still open from this round:** `swift test` cannot build its test target (F5) — tomorrow, when no pane
holds the build directory. The 4 Docker suites remain **unrun, not green** (F6).
