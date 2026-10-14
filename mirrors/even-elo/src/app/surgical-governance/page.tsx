import { SurgicalEloEmpty } from "@/components/surgical/SurgicalEloEmpty";
import { SurgicalLeaderboard } from "@/components/surgical/SurgicalLeaderboard";
import { eloIsProductionEmpty } from "@/lib/overview-modules";
import { loadEloCounts } from "@/lib/stage2-counts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Surgical ELO home. Production-empty tables render the honesty surface
 * (no VC list, no composite chart). A non-zero VC, case, or snapshot count
 * keeps the existing leaderboard, which reads score_snapshots.
 */
export default async function SurgicalEloPage() {
  const counts = await loadEloCounts();
  if (!counts || eloIsProductionEmpty(counts)) {
    return <SurgicalEloEmpty counts={counts} />;
  }
  return <SurgicalLeaderboard />;
}
