/**
 * POST /api/admin/releases/{id}/withdraw — take a build out of circulation (PRD §4.2, D12).
 *
 * WITHDRAW IS THE ROLLBACK, not a delete. `latestRelease` returns the newest row that is not
 * withdrawn, so marking one withdrawn makes the release route answer with the one before it, and
 * every Mac sees a different version at its next check and walks itself backwards (§7 steps 3–10).
 * That is Build R3's behaviour; what ships here is the mark it reads.
 *
 * In Build R1 the visible effect is narrower and worth stating: withdrawing the only release
 * turns the fleet card back to "No release published yet" and disables every install button. A
 * bundle found to be bad after publication cannot be handed to another room.
 *
 * IDEMPOTENT BY THE PREDICATE. The UPDATE matches only a row that is not already withdrawn, so a
 * second withdraw is a 404 rather than a silently moved timestamp — the withdrawal instant stays
 * the first one, which is the one the rollback happened at.
 */
import { NextRequest, NextResponse } from "next/server";
import { installAdminGuard, installError, installErrorFrom, withdrawRelease } from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await installAdminGuard(req);
  if (!guard.ok) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "admin or migration secret required" } },
      { status: 401, ...NO_STORE },
    );
  }
  const { id } = await ctx.params;
  try {
    const release = await withdrawRelease(id);
    if (!release) return installError("NOT_FOUND", "no such release, or it is already withdrawn");
    return NextResponse.json({ release }, NO_STORE);
  } catch (e) {
    return installErrorFrom(e);
  }
}
