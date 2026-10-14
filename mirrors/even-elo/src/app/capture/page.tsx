import { headers } from "next/headers";
import { isUploadCaptureHost } from "@/lib/capture/access";
import { CaptureClient } from "./CaptureClient";

export const dynamic = "force-dynamic";

export default function CapturePage() {
  const host = headers().get("host") || "governance.evenos.app";
  const hostLabel = isUploadCaptureHost(host) ? host : `${host}/capture`;
  return <CaptureClient initialHostLabel={hostLabel} />;
}
