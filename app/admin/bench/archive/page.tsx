import Link from "next/link";
import { redirect } from "next/navigation";
import { verifyAdminJwt } from "@/lib/auth";
import { readAdminCookie } from "@/lib/cookie";
import { AdminShell } from "@/components/admin/AdminShell";
import { BenchClient } from "@/components/admin/BenchClient";
import { WakeLockBadge } from "@/components/admin/WakeLockBadge";

export const dynamic = "force-dynamic";

export default async function BenchArchivePage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    email = String((await verifyAdminJwt(cookie)).email ?? "");
  } catch {
    redirect("/admin");
  }

  return (
    <AdminShell
      adminEmail={email}
      active="bench"
      pageTitle="Bench — archive & room setup"
      headerRight={<WakeLockBadge />}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500">SECONDARY WORKSPACE</p>
          <p className="text-caption text-even-ink-600">
            Session history and room administration stay out of the live fleet scan.
          </p>
        </div>
        <Link
          href="/admin/bench"
          className="min-h-11 inline-flex items-center px-4 rounded-lg text-label font-semibold bg-even-navy-800 text-even-white hover:bg-even-navy-900"
        >
          Back to live fleet
        </Link>
      </div>
      <BenchClient />
    </AdminShell>
  );
}
