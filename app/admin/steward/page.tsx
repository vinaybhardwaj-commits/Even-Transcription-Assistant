/**
 * /admin/steward - the ENC steward: summary, items to approve or reject, questions, run history, spend vs cap,
 * enable switch and mode (ENC-W2, contract UI item 4). Thin server component: auth, reads, then StewardClient.
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { StewardClient } from "@/components/admin/enc/StewardClient";
import { getStewardItems, getStewardRuns, getStewardSettings } from "@/lib/enc/queries";

export const dynamic = "force-dynamic";

export default async function AdminStewardPage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    email = String((await verifyAdminJwt(cookie)).email ?? "");
  } catch {
    redirect("/admin");
  }

  const [{ settings, spend_today_usd }, items, runs] = await Promise.all([getStewardSettings(), getStewardItems({ limit: 200 }), getStewardRuns(30)]);

  return (
    <AdminShell adminEmail={email} active="steward" pageTitle="Steward">
      <StewardClient settings={settings} spendToday={spend_today_usd} items={items} runs={runs} />
    </AdminShell>
  );
}
