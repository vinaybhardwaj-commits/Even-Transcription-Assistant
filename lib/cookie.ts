/**
 * lib/cookie.ts — session cookie helpers per PRD §4.15.
 *
 * Doctor cookie: eta_session — Path=/{slug}/, scoped so cookies don't leak
 * across doctors on the same domain.
 * Admin cookie:  eta_admin_session — Path=/{ADMIN_BASE_PATH}/.
 *
 * Attributes: HttpOnly + Secure + SameSite=Strict + Max-Age=30d (rolling).
 */

import { cookies } from "next/headers";
import { DOCTOR_COOKIE, ADMIN_COOKIE } from "@/lib/auth";

const TTL_DAYS = 30;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

export async function setDoctorCookie(
  jwt: string,
  slug: string
): Promise<void> {
  const c = await cookies();
  c.set(DOCTOR_COOKIE, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: `/${slug}`,
    maxAge: TTL_SECONDS,
  });
}

export async function clearDoctorCookie(slug: string): Promise<void> {
  const c = await cookies();
  c.set(DOCTOR_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: `/${slug}`,
    maxAge: 0,
  });
}

export async function readDoctorCookie(): Promise<string | null> {
  const c = await cookies();
  return c.get(DOCTOR_COOKIE)?.value ?? null;
}

export async function setAdminCookie(jwt: string): Promise<void> {
  const c = await cookies();
  const path = `/${process.env.ADMIN_BASE_PATH ?? "admin"}`;
  c.set(ADMIN_COOKIE, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path,
    maxAge: TTL_SECONDS,
  });
}

export async function readAdminCookie(): Promise<string | null> {
  const c = await cookies();
  return c.get(ADMIN_COOKIE)?.value ?? null;
}
