/** Bearer CRON_SECRET, constant time. The same check as app/api/cron/jev-sweep; a bare x-vercel-cron header does not authorise. */
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

export function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const want = Buffer.from(`Bearer ${secret}`, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}
