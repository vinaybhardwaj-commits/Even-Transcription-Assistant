import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { CaptureBanner } from "@/components/capture/CaptureChrome";

export function CaptureFlagOff({
  title,
  crumb,
}: {
  title: string;
  crumb: string;
}) {
  return (
    <>
      <TopNav />
      <CaptureBanner />
      <main className="mx-auto max-w-[1180px] px-6 py-8 sm:px-8">
        <div className="mb-3 flex items-center gap-2 text-[13px] text-stone-500">
          <Link href="/surgical-governance" className="font-medium text-brand hover:underline">
            Surgical Governance
          </Link>
          <span>/</span>
          <span className="font-semibold text-stone-900">{crumb}</span>
        </div>
        <h1 className="text-[1.55rem] font-bold tracking-tight">{title}</h1>
        <div className="mt-4 max-w-2xl rounded-xl border border-dashed border-teal-300 bg-teal-50 px-4 py-3 text-sm leading-relaxed text-teal-900">
          <strong className="text-brand">FEATURE_OT_CAPTURE is off.</strong> Uploads are rejected
          and this queue is not served. Set the flag to exactly <span className="font-mono">true</span> on
          a Preview deployment to smoke Stage 1. Leave production off.
        </div>
      </main>
    </>
  );
}
