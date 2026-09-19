# ETA — OVERLAPPING WRITERS ON AN ENCOUNTER · PRD v1.0 · 18 Sep 2026
Orchestrator. Written from ETA-CLAIM-TTL-OVERLAP-SURVEY-17-SEP-2026.md. All decisions below are SETTLED.
No open issues. Ratified by V, 18 Sep 2026.

## 0. WHAT THIS IS ACTUALLY ABOUT
The survey's headline reframes the item. The TTL timeline as originally posed is almost certainly NOT
reachable, because the platform kills an invocation at maxDuration (300 s) and the claim is taken after the
invocation starts, so a holder dies before its own claim expires.

What IS reachable today, with no TTL expiry involved, are two doors the claim does not cover:
  (a) the doctor's "Retry processing" button runs the STREAMING branch, which takes no claim, while the
      background step machine is still running;
  (b) the admin recovery doors null a live claim unconditionally, and the step machine's own unfenced
      release then clears whatever claim replaced it.

Blast radius is clinical, not bookkeeping: note_json and cdmss_json are EMAILED TOGETHER and can come from
different generations of the same consultation; and a note can be generated from the finalize PLACEHOLDER
transcript, stored beside the real transcript, and never regenerated (survey M3), because once any note
exists step mode never generates another.

No cross-patient mixing is possible: every write is WHERE id = $id over that encounter's own audio.

## 1. SETTLED DECISIONS

C1 — THE CLAIM GAINS A HOLDER, WITH NO NEW COLUMN AND NO MIGRATION.
    processing_step_at is ALREADY unique per successful claim (guarded UPDATE, microsecond timestamptz).
    The claim simply does not return it. Add RETURNING processing_step_at and treat that value as the
    fencing token. Every release and every protected write carries AND processing_step_at = $mine.
    A write that matches 0 rows has lost the claim and must not be retried silently — it is logged.
    Rationale: lib/diarize-gate.ts already runs exactly this idiom (holder + steal-only-expired +
    holder-fenced release) on the same Neon HTTP handle, in production. Reuse the idiom, not the table.
    REJECTED: a new fencing-token column (process_attempts cannot serve — it is reset to 0 on release);
    advisory locks (no session on the HTTP pooled handle); interactive transactions (would hold a
    connection open across minutes of LLM calls).

C2 — THE STREAMING BRANCH TAKES THE SAME CLAIM.
    Today it takes none. It must claim before it does any work that writes, and release fenced.
    If it cannot claim, it does NOT run: it returns a structured refusal carrying how long the current
    holder has held it. This is the single change that closes door (a).

C3 — THE STREAMING BRANCH MUST RESPECT jobPending.
    translateIfNeeded sets jobPending when a chunked job is still running; only step mode reads it.
    The streaming branch currently ignores it and generates the note from the finalize placeholder.
    It must read it and refuse in the same shape as C2. This is the direct cause of M3.

C4 — RETRY AVAILABILITY IS DERIVED AT READ TIME, SERVER-SIDE, AGAINST A FRESH CLOCK.
    Today the client computes it from recorded_at, which is stamped when the RECORDING SCREEN OPENS, so
    for any consultation longer than five minutes the button is on screen the moment processing begins.
    Replace with a server-derived boolean on the encounter read: true only when the encounter is
    processing/failed AND no live claim is held AND nothing has progressed for the idle threshold.
    The client renders the button off that flag and computes nothing itself.
    This follows D-11: a signal about absence is derived by the reader, at read time, never stored.

C5 — THE ADMIN RECOVERY DOORS STOP NULLING A LIVE CLAIM SILENTLY.
    resume-processing may steal only an EXPIRED claim. Stealing a live one requires an explicit force
    parameter and writes an audit_log row naming what it stole.

C6 — THE REAPER MUST NOT FLIP A ROW THAT HOLDS A LIVE CLAIM.
    reap-stuck moves processing rows older than 30 min without looking at processing_step_at, so it can
    mark an encounter failed while a step is mid-flight.

C7 — REMEDIATION IS AN ADMIN ROUTE IN PRODUCTION, NOT A SCRIPT.
    Vercel will not release the production secrets to a local pull, and regeneration needs the production
    note generator and database. So: an admin route that (i) GET = dry run, listing affected encounters
    and counts, (ii) POST = regenerate the note from the real transcript.
    Detection signal (survey 6.1): note_json IS NOT NULL AND transcript_clean IS DISTINCT FROM
    transcript_raw. Rows predating transcript_clean being populated may false-positive; the route must
    take a recorded_at floor and report what it excluded.
    NEVER touches note_json_edited — a doctor's own edit is final, and send prefers it.
    Every regeneration writes an audit_log row.
    V's ruling, 18 Sep 2026: find them, THEN regenerate. Not flag-and-leave.

## 2. BUILD ORDER
Phase 1 — C1, C2, C3. Server-side only, no UI, no migration. Closes both corruption doors.
Phase 2 — C4, C5, C6. Retry availability, the admin doors, the reaper.
Phase 3 — C7. Detection and regeneration route.
Each phase: Sonnet builds, Opus refutes, orchestrator merges and promotes.

## 3. WHAT MUST BE PROVEN, NOT ASSERTED
- Two concurrent writers cannot both pass the claim.
- A write from a holder that has lost its claim matches 0 rows and is logged, not applied.
- With a chunked job pending, the streaming branch does not generate a note.
- A release from a stale holder does not clear a newer claim.
- None of the above changes behaviour for a single uncontended run.

## 4. STILL UNVERIFIED (carried from the survey, does not block Phase 1)
- Whether Vercel/Next bound after() work by maxDuration from invocation start. Phase 1 is correct either
  way; this fact only decides whether the original TTL timeline is also live.
- Production frequency of M2/M3. Phase 3's dry run is what will answer it.
