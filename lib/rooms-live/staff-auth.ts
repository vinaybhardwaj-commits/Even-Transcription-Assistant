/**
 * lib/rooms-live/staff-auth.ts — the OPD-staff login of Rooms Live (SPEC-v1 AMENDMENT 2). All in new files; no auth helper is edited.
 *   JWT: audience "staff", claims { staff: true, name }, 12 h, HS256, signed with env JWT_SECRET_STAFF — NEVER the admin secret, so a staff token can never pass
 *        benchAdminGuard / verifyAdminJwt (other secret, other audience).
 *   Cookie eta_staff_session: Path=/, HttpOnly, Secure, SameSite=Lax, 12 h.
 *   PIN: one shared PIN, bcrypt hash in env ROOMS_LIVE_STAFF_PIN_HASH. The staff member also types a name (1-64 chars), which is shown on claims.
 *   Rate limit (FIX-1 F7, F26): every attempt is counted BEFORE bcrypt runs and forgiven on success, so net FAILED attempts only, 10 per minute per client IP (the OPD floor shares one egress IP, so successful logins never count), IN MEMORY, PER
 *        SERVER INSTANCE (a serverless fleet has several instances: the real ceiling is 10 x instances per minute; the bcrypt cost and the shared-PIN design are the
 *        second line). The 11th attempt inside the minute is refused with 429 before the PIN is even checked. Constant-time compare: bcrypt.compare, and a dummy hash is compared when the env is unset
 *        so the timing does not tell whether the login is configured.
 * Env names (GATING sets them; no value is ever in code, tests or logs): JWT_SECRET_STAFF, ROOMS_LIVE_STAFF_PIN_HASH.
 */
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const STAFF_COOKIE = "eta_staff_session";
export const STAFF_TTL_S = 12 * 3600;
export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 60_000;

const secret = (env: Record<string, string | undefined> = process.env): Uint8Array => {
  const v = (env.JWT_SECRET_STAFF ?? "").trim();
  if (!v) throw new Error("JWT_SECRET_STAFF not configured");
  return new TextEncoder().encode(v);
};

export type StaffClaims = { staff: true; name: string };

/** a display name: trimmed, control characters removed, 1-64 chars; null when it does not qualify */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return n.length >= 1 && n.length <= 64 ? n : null;
}

export async function signStaffJwt(name: string, env?: Record<string, string | undefined>): Promise<string> {
  return new SignJWT({ staff: true, name }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setAudience("staff").setExpirationTime(`${STAFF_TTL_S}s`).sign(secret(env));
}

export async function verifyStaffJwt(token: string, env?: Record<string, string | undefined>): Promise<StaffClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(env), { audience: "staff", algorithms: ["HS256"] });
    const name = cleanName(payload.name);
    return payload.staff === true && name ? { staff: true, name } : null;
  } catch {
    return null;
  }
}

export async function readStaffCookie(): Promise<string | null> {
  const c = await cookies();
  return c.get(STAFF_COOKIE)?.value ?? null;
}

/** the Set-Cookie options, shared by login (set) and logout (expire) */
export const staffCookieOptions = (maxAge: number) => ({ httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge });

// --- rate limit (per instance, in memory, failures only) ----------------------------------------------------------------
const failures = new Map<string, number[]>();
const recentFailures = (ip: string, now: number): number[] => (failures.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);

/** true when this IP already failed RATE_LIMIT times inside the window: refuse before checking anything */
export function rateLimited(ip: string, now: number = Date.now()): boolean {
  return recentFailures(ip, now).length >= RATE_LIMIT;
}
/** record one FAILED attempt */
export function recordFailure(ip: string, now: number = Date.now()): void {
  const recent = recentFailures(ip, now);
  recent.push(now);
  failures.set(ip, recent);
  if (failures.size > 5000) for (const [k, v] of failures) if (v.every((t) => now - t >= RATE_WINDOW_MS)) failures.delete(k);
}
/**
 * F26: count the attempt BEFORE bcrypt runs. Synchronous check-and-record (no await between), so N concurrent requests from one IP are all counted
 * before any bcrypt.compare completes: at most RATE_LIMIT of them ever reach bcrypt. Returns false (refuse, nothing recorded) when the IP is already at the limit.
 * A successful login calls forgiveAttempt, so successful logins still never count against the shared OPD egress IP.
 */
export function beginAttempt(ip: string, now: number = Date.now()): boolean {
  if (rateLimited(ip, now)) return false;
  recordFailure(ip, now);
  return true;
}
/** undo the one attempt beginAttempt recorded (call on success only) */
export function forgiveAttempt(ip: string, now: number = Date.now()): void {
  const recent = recentFailures(ip, now);
  recent.pop();
  if (recent.length) failures.set(ip, recent);
  else failures.delete(ip);
}
export const resetRateLimitForTests = (): void => failures.clear();

// a fixed valid bcrypt hash (of a random string): compared when the env hash is missing, so "not configured" costs the same time as "wrong PIN"
const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8.4GYD3SGdQxA4nqkGpHtU1b1E6iUe";

/** true only for the right PIN; false for anything else, including an unset hash */
export async function pinOk(pin: unknown, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const hash = (env.ROOMS_LIVE_STAFF_PIN_HASH ?? "").trim();
  const candidate = typeof pin === "string" && pin.length >= 1 && pin.length <= 32 ? pin : "";
  if (!hash) {
    await bcrypt.compare(candidate, DUMMY_HASH).catch(() => false);
    return false;
  }
  try {
    return candidate.length > 0 && (await bcrypt.compare(candidate, hash));
  } catch {
    return false;
  }
}

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  const first = xf ? xf.split(",")[0]!.trim() : "";
  return first || req.headers.get("x-real-ip") || "unknown";
}
