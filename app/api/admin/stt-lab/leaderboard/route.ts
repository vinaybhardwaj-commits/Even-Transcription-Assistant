/**
 * GET /api/admin/stt-lab/leaderboard?lang=&since=&tier=&subject= — composite per-engine board.
 *
 * `subject` ∈ encounter (DEFAULT) | bench_window | all. It defaults to encounter so the numbers
 * mean what they have always meant; mixing consultations with room windows is an explicit ask.
 */
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
  const tier = url.searchParams.get("tier") === "scribe" ? "scribe" : "asr";
  const languageBucket = lang === "english" || lang === "indic" ? lang : "all";
  const subjectParam = url.searchParams.get("subject");
  const subjectKind = subjectParam === "bench_window" || subjectParam === "all" ? subjectParam : "encounter";
  return respondOk(await computeLeaderboard({ languageBucket, sinceDays: since ? Number(since) : null, tier, subjectKind }));
}
