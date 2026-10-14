/**
 * lib/sql-guard-core.ts — read-only SQL guard for the Lab MCP `audit_query` tool (pure).
 *
 * Mirrors the vetted Even-OS Database Explorer safety: SELECT/WITH only · single statement ·
 * no writes/DDL/system-read functions · a hard LIMIT ceiling (auto-added when absent). The audit
 * DB it fronts is de-identified (finding text + prescription uid; no PHI). Pure → unit-testable.
 */

// Write/DDL + system-read tokens that must never appear. `comment` is intentionally NOT here — it
// is a legitimate column name (opd_audit_feedback.comment) and a leading DDL `COMMENT ON` is already
// blocked by the SELECT/WITH-only rule.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|reindex|refresh|call|merge|lock|into|nextval|setval)\b|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink|pg_sleep|current_setting|set_config|pg_terminate|pg_cancel/i;

// PHI-BEARING RELATIONS — hard-blocked as whole words anywhere in the query (FROM, JOIN,
// comma-join, subquery — a word match can't be dodged by aliasing or nesting). These tables
// carry raw clinician-typed clinical text / patient presentations:
//   traces / trace_events → input, question_preview, final_answer_text, meta, payload
//   appropriateness_runs  → input/output (the pasted case)
//   ccb_briefs / care_track_assignments → member-linked care content
//   opd_audit_feedback    → free-text reviewer comment
// The audit_query tool promises "de-identified, no PHI"; this ENFORCES it (the guard had no
// table restriction before). De-identified SUMMARY VIEWS (v_trace_summary,
// v_appropriateness_summary) expose the safe, non-PHI columns for pipeline mining — their
// names deliberately avoid these tokens so they pass. Adjust the view, never this list, to widen.
const BLOCKED_RELATIONS = /\b(traces|trace_events|appropriateness_runs|ccb_briefs|care_track_assignments|opd_audit_feedback)\b/i;

export function guardReadOnlySql(raw: string, maxLimit = 500): { ok: true; sql: string } | { ok: false; error: string } {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok: false, error: 'sql required' };
  const noTrailing = trimmed.replace(/;\s*$/, '');
  if (noTrailing.includes(';')) return { ok: false, error: 'only a single statement is allowed (no ";")' };
  if (!/^(with|select)\b/i.test(noTrailing)) return { ok: false, error: 'only SELECT / WITH queries are allowed' };
  const m = noTrailing.match(FORBIDDEN);
  if (m) return { ok: false, error: `forbidden token "${m[0]}" — writes, DDL and system functions are blocked` };
  const rel = noTrailing.match(BLOCKED_RELATIONS);
  if (rel) return { ok: false, error: `blocked relation "${rel[0]}" — it carries PHI (raw clinical text). Use the de-identified summary views (v_trace_summary, v_appropriateness_summary) for pipeline mining.` };
  const lim = noTrailing.match(/\blimit\s+(\d+)\b/i);
  if (lim) {
    if (Number(lim[1]) > maxLimit) return { ok: false, error: `LIMIT must be ≤ ${maxLimit}` };
    return { ok: true, sql: noTrailing };
  }
  return { ok: true, sql: `${noTrailing} LIMIT ${maxLimit}` };
}
