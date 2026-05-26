/**
 * lib/auth.ts — JWT primitives for Even Transcription Assistant.
 *
 * Two separate token classes per PRD §4.15 + §7.1:
 *   - Doctor JWT: audience "doctor", signed with JWT_SECRET_DOCTOR
 *   - Admin JWT:  audience "admin",  signed with JWT_SECRET_ADMIN
 *
 * Cross-class tokens are rejected at verify time (wrong secret OR wrong
 * audience claim => verify throws). This is the second line of defense
 * after the audience claim itself.
 *
 * Cookies (set by API routes, not here):
 *   - eta_session       — doctor; Path=/dr/<slug>/, Max-Age=30 days, rolling
 *   - eta_admin_session — admin;  Path=/<ADMIN_BASE_PATH>/, Max-Age=30 days
 *
 * Sprint 0: just sign + verify. Sprint 1 wires PIN verify + lockout
 * escalation (5/10/20/30 thresholds per §4.15).
 */

import { jwtVerify, SignJWT, type JWTPayload } from "jose";

export const DOCTOR_COOKIE = "eta_session";
export const ADMIN_COOKIE = "eta_admin_session";
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type Audience = "doctor" | "admin";

export type DoctorClaims = JWTPayload & {
  doctor_id: string;
  slug: string;
  aud: "doctor";
};

export type AdminClaims = JWTPayload & {
  admin_id: string;
  email: string;
  aud: "admin";
};

function secretFor(aud: Audience): Uint8Array {
  const env =
    aud === "doctor" ? process.env.JWT_SECRET_DOCTOR : process.env.JWT_SECRET_ADMIN;
  if (!env) throw new Error(`JWT_SECRET_${aud.toUpperCase()} not configured`);
  return new TextEncoder().encode(env);
}

export async function signDoctorJwt(claims: {
  doctor_id: string;
  slug: string;
}): Promise<string> {
  return new SignJWT({ doctor_id: claims.doctor_id, slug: claims.slug })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience("doctor")
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secretFor("doctor"));
}

export async function signAdminJwt(claims: {
  admin_id: string;
  email: string;
}): Promise<string> {
  return new SignJWT({ admin_id: claims.admin_id, email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience("admin")
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secretFor("admin"));
}

export async function verifyDoctorJwt(token: string): Promise<DoctorClaims> {
  const { payload } = await jwtVerify(token, secretFor("doctor"), {
    audience: "doctor",
  });
  return payload as DoctorClaims;
}

export async function verifyAdminJwt(token: string): Promise<AdminClaims> {
  const { payload } = await jwtVerify(token, secretFor("admin"), {
    audience: "admin",
  });
  return payload as AdminClaims;
}
