import { CaptureFlagOff } from "@/components/capture/CaptureFlagOff";
import { isOtCaptureEnabled } from "@/lib/capture/access";
import { SheetsClient } from "./SheetsClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function OtSheetsPage() {
  if (!isOtCaptureEnabled()) {
    return <CaptureFlagOff title="OT sheets" crumb="OT sheets" />;
  }
  return <SheetsClient />;
}
