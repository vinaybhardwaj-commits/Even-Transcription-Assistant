import { notFound } from "next/navigation";
import { CaptureFlagOff } from "@/components/capture/CaptureFlagOff";
import { isOtCaptureEnabled } from "@/lib/capture/access";
import { isUuid } from "@/lib/capture/staff";
import { SheetDetailClient } from "./DetailClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function OtSheetDetailPage({ params }: { params: { id: string } }) {
  if (!isOtCaptureEnabled()) {
    return <CaptureFlagOff title="OT sheet" crumb="OT sheets" />;
  }
  if (!isUuid(params.id)) notFound();
  return <SheetDetailClient id={params.id} />;
}
