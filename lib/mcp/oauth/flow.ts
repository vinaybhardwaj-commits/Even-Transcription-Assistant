/** lib/mcp/oauth/flow.ts — what email/start, email/verify and email/consent share: the pending cookie, the form body and the same-origin check. */
import type { NextRequest, NextResponse } from "next/server";
import { EMAIL_PATH, PENDING_COOKIE, PENDING_PURPOSE } from "./config";
import { verifyBlob } from "./crypto";

export type Pending = { cid: string; ru: string; cc: string; st: string | null; res: string; pid: string; exp: number };
export const MAX_FORM_BYTES = 2048;

/** The signed pending blob, or null when it is missing, forged, of another purpose, expired or has no pending id. */
export function readPending(req: NextRequest): Pending | null {
  const p = verifyBlob<Pending>(PENDING_PURPOSE, req.cookies.get(PENDING_COOKIE)?.value);
  if (!p || typeof p.exp !== "number" || p.exp < Math.floor(Date.now() / 1000) || typeof p.pid !== "string" || !p.pid) return null;
  return p;
}

/** Clears the pending/consent cookie. */
export function done(res: NextResponse): NextResponse {
  res.cookies.set(PENDING_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: EMAIL_PATH, maxAge: 0 });
  return res;
}

/** A form-urlencoded body of at most 2 KB, or null. JSON and anything else are refused. */
export async function readForm(req: NextRequest): Promise<URLSearchParams | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  try {
    const raw = await req.text();
    return raw.length <= MAX_FORM_BYTES ? new URLSearchParams(raw) : null;
  } catch {
    return null;
  }
}

/** False for a POST that carries a foreign Origin (including the string "null"). An absent Origin is accepted: the SameSite cookie and, on the consent page, the CSRF token still bind. */
export const originOk = (req: NextRequest): boolean => {
  const o = req.headers.get("origin");
  return o === null || o === req.nextUrl.origin;
};
