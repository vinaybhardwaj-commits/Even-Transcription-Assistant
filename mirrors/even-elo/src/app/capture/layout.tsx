import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "OT Sheet Capture",
  description: "Photograph an OT Tracking Sheet for Even Governance. No login. Stage 1 stores the image only.",
  manifest: "/capture/manifest.webmanifest",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "OT Capture", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0c0a09",
};

export default function CaptureLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#0c0a09] text-stone-50">{children}</div>;
}
