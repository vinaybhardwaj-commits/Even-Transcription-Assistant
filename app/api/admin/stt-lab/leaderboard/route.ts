/** GET /api/admin/stt-lab/leaderboard?lang=&since= — composite per-engine leaderboard. */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { computeLeaderboard } from "@/lib/stt/leaderboard";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const url = new URL(req.url);
  const lang = url.searchParams.get("lang");
  const since = url.searchParams.get("since");
  const languageBucket = lang === "english" || lang === "indic" ? lang : "all";
  return respondOk(await computeLeaderboard({ languageBucket, sinceDays: since ? Number(since) : null }));
}
