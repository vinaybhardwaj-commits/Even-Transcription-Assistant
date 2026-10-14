import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AdminShell } from "@/components/AdminShell";
import MmHubClient from "@/components/mm/MmHubClient";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page() {
  // SGC predicate, re-stated per page (decision 13). Middleware authenticates
  // but does not authorize — a missing predicate makes this page reachable by
  // every active even-elo user.
  const u = await getCurrentUser();
  if (!u || u.status !== "active" || !(u.is_super_admin || u.is_sgc_member)) redirect("/home");
  return (
    <AdminShell
      breadcrumbs={[{ label: "Governance", href: "/overview" }, { label: "M&M" }]}
      title="Morbidity & Mortality"
      subtitle="Clinical-layer analysis of deaths and morbid outcomes — outcome-blinded, source-cited, committee-ratified. Advisory; never a clinician scorecard."
    >
      <MmHubClient />
    </AdminShell>
  );
}
