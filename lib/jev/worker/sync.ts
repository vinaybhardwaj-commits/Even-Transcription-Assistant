/**
 * lib/jev/worker/sync.ts — mirror the question-set FILES into the DB, and move a set's status (PRD §4, §4.3).
 *
 *   SYNC is idempotent: an unseen (id, version) is inserted as `draft` with its questions and a first event; a seen one whose
 *   hash is unchanged is a no-op; a seen one whose hash CHANGED is REFUSED (`hash_changed`): a set version is immutable, a
 *   wording change must be a new version. Two versions with identical content are refused too (`duplicate_content`).
 *   STATUS moves only forward (draft < bench < shadow < live), except to `retired`, which is always allowed. `shadow` and `live`
 *   need `ratifiedBy` (a named person; the table's CHECK enforces it again). `live` also needs the use's JEV_*_LIVE flag, which
 *   needs a deploy. A move without ratification is refused. Every move is an audit event.
 */
import { sql } from "@/lib/db";
import { QUESTION_SET_FILES } from "@/jev/question-sets";
import { liveFlagOn, type RealUse } from "./flags";
import { QuestionSetError, SET_STATUSES, setSha, questionSha, validateSetFile, type QuestionSetFile, type SetStatus } from "./sets";

export type SyncOutcome = { id: string; version: string; sha: string; result: "inserted" | "unchanged" | "hash_changed" | "duplicate_content" | "invalid"; detail?: string };

export async function syncQuestionSets(files: unknown[] = QUESTION_SET_FILES): Promise<SyncOutcome[]> {
  const out: SyncOutcome[] = [];
  for (const raw of files) {
    let f: QuestionSetFile;
    try {
      f = validateSetFile(raw);
    } catch (e) {
      const r = raw as { id?: unknown; version?: unknown };
      out.push({ id: String(r?.id ?? "?"), version: String(r?.version ?? "?"), sha: "", result: "invalid", detail: e instanceof QuestionSetError ? e.reason : "invalid" });
      continue;
    }
    const sha = setSha(f);
    const have = (await sql`SELECT content_sha256 FROM jev_question_set WHERE id = ${f.id} AND version = ${f.version}`) as Array<{ content_sha256: string }>;
    if (have[0]) {
      out.push({ id: f.id, version: f.version, sha, result: have[0].content_sha256 === sha ? "unchanged" : "hash_changed" });
      continue;
    }
    const dup = (await sql`SELECT id, version FROM jev_question_set WHERE content_sha256 = ${sha}`) as Array<{ id: string; version: string }>;
    if (dup[0]) { out.push({ id: f.id, version: f.version, sha, result: "duplicate_content", detail: `${dup[0].id}@${dup[0].version}` }); continue; }
    await sql.transaction([
      sql`INSERT INTO jev_question_set (id, version, use, subject_type, state_schema, model_pin, content_sha256, status, bands, calibration_ref, created_by)
          VALUES (${f.id}, ${f.version}, ${f.use}, ${f.subject_type}, ${f.state_schema}, ${f.model_pin}, ${sha}, 'draft', ${f.bands ? JSON.stringify(f.bands) : null}::jsonb, ${f.calibration_ref ?? null}, ${f.created_by})
          ON CONFLICT (id, version) DO NOTHING`,
      ...f.questions.map((q) => sql`
        INSERT INTO jev_question (question_set_id, version, question_id, kind, body, option_order, gate_question_id, options, escape_options, bands, calibration, question_sha256)
        VALUES (${f.id}, ${f.version}, ${q.question_id}, ${q.kind}, ${JSON.stringify(q.body)}::jsonb, ${q.option_order ?? "forward"}, ${q.gate_question_id ?? null},
                ${q.kind === "choice" ? Object.keys((q.body as { criteria: Record<string, unknown> }).criteria) : null}::text[], ${q.escape_options ?? []}::text[], ${q.bands ? JSON.stringify(q.bands) : null}::jsonb, ${q.calibration ? JSON.stringify(q.calibration) : null}::jsonb, ${questionSha(q)})
        ON CONFLICT (question_set_id, version, question_id) DO NOTHING`),
      sql`INSERT INTO jev_question_set_event (question_set_id, version, from_status, to_status, actor, reason) VALUES (${f.id}, ${f.version}, NULL, 'draft', ${f.created_by}, 'synced from file')`,
    ]);
    out.push({ id: f.id, version: f.version, sha, result: "inserted" });
  }
  return out;
}

export type MoveResult = { ok: true; from: SetStatus; to: SetStatus } | { ok: false; error: "not_found" | "backward" | "unchanged" | "unratified" | "live_flag_off" | "bad_status" };

export async function moveStatus(input: { id: string; version: string; to: string; actor: string; reason?: string; ratifiedBy?: string }): Promise<MoveResult> {
  if (!(SET_STATUSES as readonly string[]).includes(input.to)) return { ok: false, error: "bad_status" };
  const to = input.to as SetStatus;
  const rows = (await sql`SELECT status, use FROM jev_question_set WHERE id = ${input.id} AND version = ${input.version}`) as Array<{ status: SetStatus; use: string }>;
  if (!rows[0]) return { ok: false, error: "not_found" };
  const from = rows[0].status;
  if (from === to) return { ok: false, error: "unchanged" };
  if (to !== "retired" && SET_STATUSES.indexOf(to) < SET_STATUSES.indexOf(from)) return { ok: false, error: "backward" };
  if (from === "retired") return { ok: false, error: "backward" };
  if ((to === "shadow" || to === "live") && !input.ratifiedBy?.trim()) return { ok: false, error: "unratified" };
  if (to === "live" && rows[0].use !== "legacy" && !liveFlagOn(rows[0].use as RealUse)) return { ok: false, error: "live_flag_off" };
  await sql.transaction([
    sql`UPDATE jev_question_set SET status = ${to},
          ratified_by = CASE WHEN ${to} IN ('shadow', 'live') THEN ${input.ratifiedBy ?? null} ELSE ratified_by END,
          ratified_at = CASE WHEN ${to} IN ('shadow', 'live') THEN now() ELSE ratified_at END
        WHERE id = ${input.id} AND version = ${input.version}`,
    sql`INSERT INTO jev_question_set_event (question_set_id, version, from_status, to_status, actor, reason) VALUES (${input.id}, ${input.version}, ${from}, ${to}, ${input.actor}, ${input.reason ?? null})`,
  ]);
  return { ok: true, from, to };
}
