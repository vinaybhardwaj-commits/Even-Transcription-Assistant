// ============================================
// EPI — Custom Auth (JWT + bcrypt) ported from Rounds
// PIN-only. Email/password + magic link deferred.
// ============================================

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";

const COOKIE_NAME = "epi_session";
const JWT_EXPIRY = "7d";
const SALT_ROUNDS = 10;

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return new TextEncoder().encode(secret);
}

export interface JWTPayload {
  profileId: string;
  email: string;
  full_name: string;
  position_id: string;
  position_label: string;
  hospital_id: string;
  hospital_code: string;
  status: string;
  is_super_admin: boolean;
  is_sgc_member: boolean;
  is_hr: boolean;
  is_site_medical_head: boolean;
  must_change_pin?: boolean;
}

export async function createToken(payload: JWTPayload): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(getJwtSecret());
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as unknown as JWTPayload;
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function getSessionCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(COOKIE_NAME)?.value ?? null;
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function getCurrentUser(): Promise<JWTPayload | null> {
  const token = await getSessionCookie();
  if (!token) return null;
  return verifyToken(token);
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, SALT_ROUNDS);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

export function isValidEvenEmail(email: string): boolean {
  return email.toLowerCase().endsWith("@even.in");
}

export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

const SUPERUSER_EMAIL = (
  process.env.SUPERUSER_EMAIL || "vinay.bhardwaj@even.in"
).toLowerCase();

export function isSuperuserEmail(email: string): boolean {
  return email.toLowerCase() === SUPERUSER_EMAIL;
}


/**
 * Server-side helper for write routes: returns the actor's position label
 * derived from the JWT cookie. Throws if not authenticated — routes that
 * are middleware-protected can rely on the throw never firing in practice;
 * the throw is defensive for unit tests that hit handlers directly.
 */
export async function actorFromRequest(): Promise<{
  profileId: string;
  email: string;
  position_label: string;
  hospital_id: string;
  hospital_code: string;
}> {
  const u = await getCurrentUser();
  if (!u) throw new Error("UNAUTHENTICATED");
  return {
    profileId: u.profileId,
    email: u.email,
    position_label: u.position_label,
    hospital_id: u.hospital_id,
    hospital_code: u.hospital_code,
  };
}
