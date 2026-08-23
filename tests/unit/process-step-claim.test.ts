/**
 * The background step machine's claim — the lock that was never held.
 *
 * WHAT HAPPENED. d28b9f4 (26 June 2026) changed the per-encounter step claim from
 *
 *     SET status = 'processing'
 * to
 *     SET status = CASE WHEN status = 'complete' THEN 'complete' ELSE 'processing' END
 *
 * so that post-completion steps (CDS, diarization) would not drag a finished encounter back to
 * 'processing'. The intent was right. The SQL was not: encounter.status is the encounter_status
 * ENUM (0001), and a CASE whose branches are BOTH untyped literals resolves to TEXT, which
 * Postgres will not assign to an enum column. Every claim threw
 *
 *     column "status" is of type encounter_status but expression is of type text
 *
 * and the throw went into `.catch(() => [])`, which the caller reads as "someone else holds the
 * lock". So for nearly two months every {step:true} invocation answered `skipped: "locked"`,
 * the resume cron ran every three minutes and drained nothing, and the failure was invisible
 * because a lock that is not held looks exactly like a lock that is.
 *
 * It surfaced only because the diarize re-run needed the step machine and got "locked" thirty
 * times against an encounter whose processing_step_at was demonstrably NULL.
 *
 * Two assertions, because the bug had two halves:
 *   1. the CASE names the COLUMN in a branch, which is what types the expression;
 *   2. the catch is not silent — an error and a held lock must not look the same again.
 *
 * app/api/webhooks/resend/route.ts had the correct shape all along (THEN status) and is the
 * reference; it is checked here too so the pattern is pinned in both places.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const route = readFileSync("app/[slug]/api/encounters/[id]/process/route.ts", "utf8");
const resend = readFileSync("app/api/webhooks/resend/route.ts", "utf8");

/** Every `SET status = CASE …` assignment in a file, comments stripped. */
function statusCases(src: string): string[] {
  return [...src.replace(/^\s*--[^\n]*$/gm, "").matchAll(/status = CASE[\s\S]*?END/g)].map((m) => m[0]);
}

describe("the step claim assigns a value the enum column will accept", () => {
  it("the claim's CASE types itself off the column, not off bare literals", () => {
    const cases = statusCases(route);
    expect(cases).toHaveLength(1);
    const c = cases[0]!;
    expect(c).toMatch(/THEN status\b/);
    // the exact shape that threw for two months
    expect(c).not.toMatch(/THEN '\w+'/);
  });

  it("every enum status CASE in the app follows the same rule", () => {
    for (const c of [...statusCases(route), ...statusCases(resend)]) {
      expect(c, c).toMatch(/THEN status\b/);
    }
  });

  it("a failing claim is logged and reported, never disguised as a held lock", () => {
    const claim = /const claim = \(await sql`[\s\S]*?\)\) as Array<\{ id: string \}>;/.exec(route)?.[0] ?? "";
    expect(claim).toBeTruthy();
    expect(claim).not.toMatch(/\.catch\(\(\) =>/);       // the silent form
    expect(claim).toMatch(/claimError\s*=/);
    expect(claim).toMatch(/console\.warn/);
    expect(route).toMatch(/skipped: "locked",[^}]*claim_error: claimError/);
  });
});
