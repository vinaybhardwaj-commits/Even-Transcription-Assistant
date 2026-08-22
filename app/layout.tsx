import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Even Transcription Assistant",
  description: "Mobile-first encounter recording for clinicians at Even Hospital.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "ETA",
  },
  formatDetection: {
    telephone: false,
  },
};

/**
 * K3 A2 — THE ZOOM LOCK IS GONE.
 *
 * `maximumScale: 1` + `userScalable: false` blocked pinch zoom for everyone: the admin, the
 * doctor app and the room kiosk, all from this one declaration. It is the app's ONLY viewport
 * declaration, so removing it here restores zoom everywhere at once.
 *
 * WHY THE LOCK EXISTED, AND WHAT REPLACED IT. iOS Safari auto-zooms the page when a control
 * with a font-size under 16px receives focus, which is jarring mid-consultation; locking the
 * viewport suppressed that, at the cost of also suppressing deliberate zoom. The correct fix is
 * the other one: every input, select and textarea reachable in app/[slug] and app/room is now
 * at 16px or more, so there is nothing for iOS to zoom TO. Audited and raised in this same
 * change — RecipientsManager (2 inputs, 2 selects), notegen.css .mng-patient input (15→16),
 * RoomRecorderClient (1 input, 2 selects). PinPad is buttons, and the TipTap surface was
 * already 16px.
 *
 * IF YOU ADD A CONTROL to either app, give it text-base or larger. A 14px input here now costs
 * a zoom jump on every focus.
 */
export const viewport: Viewport = {
  themeColor: "#0055FF",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/icons/icon-192.png" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <link
          rel="preconnect"
          href="https://fonts.googleapis.com"
        />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Roboto+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans bg-even-white text-even-ink-800 antialiased">
        {children}
        {/* PWA: register the service worker after page load */}
        <Script src="/register-sw.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
