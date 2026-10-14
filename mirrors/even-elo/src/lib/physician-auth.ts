import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";

// Doctor Portal (#1) — a SEPARATE session from the admin epi_session.
// Keyed on physician_id with kind:"physician" so an admin token can never
// be mistaken for a physician token (and vice versa).
const PCOOKIE = "epi_physician_session";
const EXPIRY = "7d";

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET environment variable is required");
  return new TextEncoder().encode(s);
}

export interface PhysicianJWT {
  kind: "physician";
  physicianId: string;
  email: string;
  full_name: string;
  portal_must_change_pin?: boolean;
}

export async function createPhysicianToken(p: PhysicianJWT): Promise<string> {
  return new SignJWT(p as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(secret());
}

export async function setPhysicianCookie(token: string) {
  const c = await cookies();
  c.set(PCOOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
}
export async function clearPhysicianCookie() { const c = await cookies(); c.delete(PCOOKIE); }

export async function getCurrentPhysician(): Promise<PhysicianJWT | null> {
  const c = await cookies();
  const t = c.get(PCOOKIE)?.value;
  if (!t) return null;
  try {
    const { payload } = await jwtVerify(t, secret());
    if ((payload as Record<string, unknown>).kind !== "physician") return null;
    return payload as unknown as PhysicianJWT;
  } catch { return null; }
}

export async function hashPortalPin(pin: string): Promise<string> { return bcrypt.hash(pin, 10); }
export async function verifyPortalPin(pin: string, hash: string): Promise<boolean> { return bcrypt.compare(pin, hash); }
export function isValidPin(pin: string): boolean { return /^\d{4}$/.test(pin); }
