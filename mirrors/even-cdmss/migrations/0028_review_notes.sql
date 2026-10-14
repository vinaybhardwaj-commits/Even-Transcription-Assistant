-- 0028_review_notes — reviewer notes + the reviewed marker (Phase B, PRD §3 / §6.4).
--
-- NEXT FREE NUMBER at build time, per PRD §1.1 A-4 ("do not hardcode"). 0014–0027 are taken;
-- 0026/0027 are Phase A and A.1 of this same PRD.
--
-- EXTENDS the existing ipd_audit_feedback rather than adding a table (PRD §3): a `kind='review'`
-- row is Dr. Binita's overall note on an audit AND doubles as the reviewed marker, so one table
-- answers both "what did she think" and "has she seen this".
--
-- ADDITIVE AND IDEMPOTENT. Existing rows keep reading unchanged: `kind` defaults to 'finding', so
-- every row written by the per-finding triage since 0014 classifies correctly with no backfill.

ALTER TABLE ipd_audit_feedback
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'finding';   -- 'finding' | 'review'

ALTER TABLE ipd_audit_feedback
  ADD COLUMN IF NOT EXISTS reviewed_by_name text;

-- PRD §3 also specifies `ALTER COLUMN finding_ref DROP NOT NULL`. In THIS repo that is already the
-- case — migrations/0014_ipd_audit_report_feedback.sql declares `finding_ref TEXT` with no NOT NULL
-- (the column has always been nullable; "null = whole-audit feedback" is in its own comment). The
-- statement is kept because it is idempotent and harmless, and because if a future environment ever
-- did carry the constraint this migration should still remove it.
ALTER TABLE ipd_audit_feedback ALTER COLUMN finding_ref DROP NOT NULL;

-- ⚠️ NOT IN THE PRD, AND REQUIRED. `verdict` is declared NOT NULL in 0014, but a review row has no
-- verdict — it is a free-text note, not an adjudication. Rather than drop a constraint that is
-- correct for the 'finding' rows it was written for, review rows carry the literal verdict
-- 'review'. Nothing is altered here; this comment records why the write path supplies it.
-- The existing per-finding readers filter on the adjudication vocabulary
-- (true_positive | nitpick | false | contested | agree | disagree | needs_action), so 'review'
-- never matches them and the two kinds cannot contaminate each other.

-- One review per audit is the intent (§6.4: "edits overwrite in place and update the timestamp"),
-- which the write path implements as UPDATE-then-INSERT. A partial unique index makes that
-- guarantee structural rather than merely conventional, and leaves the append-only finding rows
-- completely unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS ipd_audit_feedback_one_review_per_audit
  ON ipd_audit_feedback (audit_id) WHERE kind = 'review';

-- The list's Reviewed / Not reviewed filter probes this per page of audit ids.
CREATE INDEX IF NOT EXISTS ipd_audit_feedback_kind_idx
  ON ipd_audit_feedback (kind, audit_id);
