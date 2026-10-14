/**
 * Doctor-portal PIN login throttle (A3).
 *
 * A 4-digit PIN has 10,000 values, so unthrottled login is a brute-force target. Limits, over a
 * rolling 15-minute window:
 *   · 5 failed attempts per account (the sign-in identifier, lower-cased email);
 *   · 20 failed attempts per client IP.
 * Past either limit the route answers 429 with a plain sentence and does NOT verify the PIN, so a
 * locked account cannot be used to keep guessing.
 *
 * ⚠️ THE ATTEMPT IS RECORDED BEFORE THE PIN IS CHECKED. Count-then-verify-then-record lets a burst of
 * parallel requests all read a low count and all get their PIN tested. Here every request INSERTs
 * its attempt first and then counts (its own row included), so at most LIMIT requests can ever see
 * a count within the limit: the one whose insert committed last always sees all the others. A
 * correct PIN removes only that request's own rows; the failure history inside the window stays.
 *
 * State lives in Postgres (table portal_login_failures, migration 034), not in memory: serverless
 * instances do not share memory, so an in-process counter is bypassed by simply being routed to a
 * fresh instance. Keys are stored as SHA-256 digests, never as the raw email or IP.
 *
 * If the table cannot be read (migration not applied yet, database blip) the check FAILS OPEN and
 * logs. The login itself needs the same database, so this only differs from "closed" in the
 * not-yet-migrated window, where locking every doctor out would be the worse outcome.
 */

import { createHash } from "node:crypto";

export const ACCOUNT_FAILURE_LIMIT = 5;
export const IP_FAILURE_LIMIT = 20;
export const LOGIN_WINDOW_MINUTES = 15;
export const RATE_LIMIT_MESSAGE =
  "Too many sign-in attempts. Please wait 15 minutes and try again.";

/** The tagged-template shape of the Neon HTTP client; typed loosely so tests can pass a fake. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

export function hashLoginKey(kind: "account" | "ip", raw: string): string {
  return createHash("sha256").update(`${kind}:${raw}`).digest("hex");
}

/** First hop of x-forwarded-for (set by Vercel's edge), else x-real-ip, else a stable placeholder. */
export function clientIp(headers: Pick<Headers, "get">): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

export interface FailureCounts {
  account: number;
  ip: number;
}

/** PURE. Blocked when the count INCLUDING the current attempt exceeds a limit: with a limit of 5 the
 *  sixth attempt in the window is the first refused. */
export function evaluateLoginLimit(counts: FailureCounts): { blocked: boolean; scope: "account" | "ip" | null } {
  if (counts.account > ACCOUNT_FAILURE_LIMIT) return { blocked: true, scope: "account" };
  if (counts.ip > IP_FAILURE_LIMIT) return { blocked: true, scope: "ip" };
  return { blocked: false, scope: null };
}

export async function recentFailureCounts(sql: SqlTag, account: string, ip: string): Promise<FailureCounts> {
  const a = hashLoginKey("account", account);
  const i = hashLoginKey("ip", ip);
  const rows = (await sql`
    SELECT
      (SELECT count(*)::int FROM portal_login_failures
        WHERE subject_kind = 'account' AND subject_key = ${a}
          AND attempted_at > now() - (${LOGIN_WINDOW_MINUTES} * interval '1 minute')) AS account_failures,
      (SELECT count(*)::int FROM portal_login_failures
        WHERE subject_kind = 'ip' AND subject_key = ${i}
          AND attempted_at > now() - (${LOGIN_WINDOW_MINUTES} * interval '1 minute')) AS ip_failures
  `) as Array<{ account_failures: number; ip_failures: number }>;
  return { account: Number(rows[0]?.account_failures ?? 0), ip: Number(rows[0]?.ip_failures ?? 0) };
}

export interface LoginAttempt {
  allowed: boolean;
  scope: "account" | "ip" | null;
  /** Row ids of this attempt, so a correct PIN can remove exactly these and nothing else. */
  attemptIds: string[];
}

/**
 * Record this attempt, THEN count (own row included) and decide. A refused attempt removes its own
 * rows so hammering a locked account cannot extend the lock. Fails open (and logs) on a storage
 * error, with no ids to release.
 */
export async function beginLoginAttempt(sql: SqlTag, account: string, ip: string): Promise<LoginAttempt> {
  try {
    const a = hashLoginKey("account", account);
    const i = hashLoginKey("ip", ip);
    const inserted = (await sql`
      INSERT INTO portal_login_failures (subject_kind, subject_key)
      VALUES ('account', ${a}), ('ip', ${i})
      RETURNING id::text AS id`) as Array<{ id: string }>;
    const attemptIds = inserted.map((r) => String(r.id));
    const verdict = evaluateLoginLimit(await recentFailureCounts(sql, account, ip));
    if (verdict.blocked) {
      await releaseLoginAttempt(sql, attemptIds);
      return { allowed: false, scope: verdict.scope, attemptIds: [] };
    }
    // Housekeeping: rows past a day have no bearing on a 15-minute window.
    if (Math.random() < 0.05) {
      await sql`DELETE FROM portal_login_failures WHERE attempted_at < now() - interval '1 day'`;
    }
    return { allowed: true, scope: null, attemptIds };
  } catch (e) {
    console.error("[portal-login-limit] check failed; allowing attempt", e instanceof Error ? e.message : e);
    return { allowed: true, scope: null, attemptIds: [] };
  }
}

/** Remove exactly these attempt rows (a correct PIN, or a refused attempt). Never throws. */
export async function releaseLoginAttempt(sql: SqlTag, attemptIds: string[]): Promise<void> {
  if (attemptIds.length === 0) return;
  try {
    await sql`DELETE FROM portal_login_failures WHERE id = ANY(${attemptIds}::bigint[])`;
  } catch (e) {
    console.error("[portal-login-limit] could not release attempt", e instanceof Error ? e.message : e);
  }
}
