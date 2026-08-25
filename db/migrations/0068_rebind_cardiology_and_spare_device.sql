-- =====================================================================
-- Migration 0068 — Build 3 recovery.
--
-- TWO UNRELATED, ADDITIVE PIECES IN ONE FILE, both idempotent, neither touching a single piece
-- of audio:
--
--   A. RE-BIND CARDIOLOGY'S SIXTEEN WRONGLY-BOUND WINDOWS (D34/D33/D33a, Build 3 §2.2).
--   B. A COLUMN FOR "A SECOND DEVICE WAS EXPLICITLY CHOSEN" (D32/P8, Build 3 §2.4).
--
-- THE ARCHIVE ALWAYS WINS. Nothing here deletes, moves, rewrites or renames a bench_chunk row or
-- an R2 object. The only rows this migration deletes are redundant bench_window ROWS — a window is
-- a 15-minute VIEW over pieces, not a piece — and every backup piece it points at stays exactly
-- where it is, readable for ever. A re-bind changes which microphone answers a window; it never
-- costs a recording.
--
-- GRANTS. bench_window, bench_chunk, bench_listener and stt_subject_job are APP-OWNED — this
-- migration runs as the owner and needs no grant to use its own tables. brain_svc is deliberately
-- granted nothing here (it has never read any of them).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Part B first — the additive schema, so Part A's data repair runs against the final shape.
--
-- P8 / D32: `spare_exists` has been derived from "a backup piece arrived", which is why the Home
-- Office Mini — one TONOR USB microphone, no chosen spare — reported a spare and drew a spare lane
-- while its Mac's own built-in microphone was auto-selected as a backup and wrote near-silence
-- (~70 KB per five minutes against the main's 4.8 MB). The fix: a spare exists only when the
-- client REPORTS a distinct second device was chosen. This column carries that report.
--
-- NULLABLE, DEFAULT NULL, AND NULL IS "NOT REPORTED" — NEVER "no spare". The browser kiosk does
-- not set it (its capture code is not touched in this build; the client half moves to the native
-- Room Recorder app, PRD R6), so today it stays NULL on every rig and every reader treats NULL as
-- "no explicitly chosen second device" → no spare lane, no spare vital, no spare alarm. The native
-- app sets it TRUE the day a real second device is chosen. The poll cannot fail because of it: it
-- rides the same bench_listener upsert as the level columns (0066), COALESCEd so an absent value
-- never erases the last one.
-- ---------------------------------------------------------------------
ALTER TABLE bench_listener
  ADD COLUMN IF NOT EXISTS spare_device boolean;

COMMENT ON COLUMN bench_listener.spare_device IS
  'D32/P8 — TRUE only when the client reported an EXPLICITLY chosen second microphone. NULL = not reported, NEVER "no spare": the arrival of a backup piece must never imply a spare exists. Every reader draws no spare lane, no spare vital and no spare alarm unless this is true.';

-- ---------------------------------------------------------------------
-- Part A — re-bind Cardiology's sixteen wrongly-bound windows (D34).
--
-- WHAT WENT WRONG (Build 3 §2.2, PRD §3.9). On 24 August at 12:25 IST (06:55:32 UTC) session
-- bs_z3gpbh6e emitted ONE mic_primary_lost event with reason "silence" — a false alarm; the main
-- microphone recorded full-length ~8.3 MB pieces continuously, idx 0..51, 06:28→10:46 UTC, with no
-- index gap and ≤3 ms of seam. The OLD window writer bound every slot from that moment to the
-- spare and nothing ever cleared it. Sixteen 15-minute windows — the slots 12:15→16:00 IST — were
-- written as source_mic='backup' and closed. Build 2's binding rule already refuses to make this
-- mistake again (a silence trip is not evidence of a dead device); this migration repairs the rows
-- it already made.
--
-- THE SIXTEEN, verified by query, are EXACTLY: session bs_z3gpbh6e, source_mic='backup',
-- state='closed'. Every backup-bound closed window on this session is wrong, because the main was
-- healthy throughout, so the predicate needs nothing more. The trailing 10:45 backup window is
-- 'open' (the session ended at 10:46, so it was never covered) and is left untouched.
--
-- WHAT THIS DOES, in order:
--   1. For each wrongly-bound slot, ensure a PRIMARY window exists, closed, with the room_day the
--      backup row carried. Where a primary window already exists for the slot (only 12:15 IST /
--      06:45 does), the INSERT falls to ON CONFLICT DO UPDATE, which fills its room_day, promotes
--      it open→closed (A8 no-regression: a slot already transcribing/transcribed/failed is never
--      dragged back), and records the re-bind. rebound_from='backup' is the OLD binding; the
--      primary row is the NEW binding; rebind_reason is the WHY. All three, per D34.
--   2. Enqueue one ASR job per re-bound window so an operator can run it (§2.2 runs FOUR first;
--      the drain is manual and spends nothing here). Idempotent.
--   3. DELETE the superseded backup WINDOW rows. NO PIECE IS DELETED: the 16 backup_chunk_* pieces
--      of bs_z3gpbh6e remain in bench_chunk and R2, untouched — only the redundant window view is
--      removed, so the slot has exactly one window (the main) and neither the stranded-audio read
--      nor the run-waiting control ever sees a duplicate. Done LAST, so steps 1 and 2 still see the
--      backup rows.
--
-- IDEMPOTENT. After it runs the backup closed rows are gone, so a second run selects nothing in
-- steps 1–3 and changes nothing; the primary rows it created are left exactly as they are, even
-- once V has transcribed some of them.
--
-- REVERSIBLE ONLY FROM A BACKUP, like 0067 — which is why the SELECT that lists the affected rows
-- is included here as a comment; it is the same predicate, so what it lists is what changes:
--
--   SELECT id, start_ms, end_ms, source_mic, state, room_day_id
--     FROM bench_window
--    WHERE session_id = 'bs_z3gpbh6e' AND source_mic = 'backup' AND state = 'closed'
--    ORDER BY start_ms;
-- ---------------------------------------------------------------------
ALTER TABLE bench_window
  ADD COLUMN IF NOT EXISTS rebind_reason text,
  ADD COLUMN IF NOT EXISTS rebound_from  text;

COMMENT ON COLUMN bench_window.rebind_reason IS
  'D34 — why a window was re-bound to a different microphone after the fact. NULL on every window the writer bound correctly first time.';
COMMENT ON COLUMN bench_window.rebound_from IS
  'D34 — the microphone this window was bound to BEFORE the re-bind (the old binding). NULL when the window was never re-bound.';

-- 1. Ensure a closed PRIMARY window for each wrongly-bound slot.
INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic,
                          grid_aligned, state, closed_at, rebind_reason, rebound_from)
SELECT 'bw_' || substr(b.session_id, 4) || '_' || b.start_ms || '_primary',
       b.session_id, b.room_day_id, b.start_ms, b.end_ms, 'primary',
       TRUE, 'closed', NOW(),
       'D34 re-bind: false mic_primary_lost(silence) at 12:25 IST 24-Aug-2026 on bs_z3gpbh6e; the main microphone recorded full-length pieces (~8.3 MB, idx 0..51, no gap) throughout, so this slot returns to the main. Old binding: backup. New binding: primary.',
       'backup'
  FROM bench_window b
 WHERE b.session_id = 'bs_z3gpbh6e'
   AND b.source_mic = 'backup'
   AND b.state = 'closed'
ON CONFLICT (session_id, start_ms, end_ms, source_mic) DO UPDATE
   SET room_day_id   = COALESCE(bench_window.room_day_id, EXCLUDED.room_day_id),
       state         = CASE WHEN bench_window.state = 'open' THEN 'closed' ELSE bench_window.state END,
       closed_at     = COALESCE(bench_window.closed_at, NOW()),
       rebind_reason = COALESCE(bench_window.rebind_reason, EXCLUDED.rebind_reason),
       rebound_from  = COALESCE(bench_window.rebound_from, EXCLUDED.rebound_from);

-- 2. Enqueue one ASR job per re-bound primary window (idempotent; spends nothing — the drain is manual).
INSERT INTO stt_subject_job (subject_type, subject_id, tier, state)
SELECT 'bench_window', 'bw_' || substr(b.session_id, 4) || '_' || b.start_ms || '_primary', 'asr', 'queued'
  FROM bench_window b
 WHERE b.session_id = 'bs_z3gpbh6e'
   AND b.source_mic = 'backup'
   AND b.state = 'closed'
ON CONFLICT (subject_type, subject_id, tier) DO NOTHING;

-- 3. Delete the superseded backup WINDOW rows. No piece is touched (see the header).
DELETE FROM bench_window
 WHERE session_id = 'bs_z3gpbh6e'
   AND source_mic = 'backup'
   AND state = 'closed';

INSERT INTO schema_migrations (version, name)
VALUES (68, '0068_rebind_cardiology_and_spare_device')
ON CONFLICT DO NOTHING;
