import { redirect } from "next/navigation";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import NoteComposerClient from "./NoteComposerClient";
import "./notegen.css";

export const dynamic = "force-dynamic";

/**
 * /{slug}/note — the typed-note authoring surface. Behind the doctor session
 * (same as the rest of /{slug}/*). Reachable by direct URL during the dark
 * phase; HomeShell adds the flag-gated entry at P4.
 */
export default async function NotePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cookie = await readDoctorCookie();
  let ok = false;
  if (cookie) {
    try { const claims = await verifyDoctorJwt(cookie); ok = claims.slug === slug; } catch { ok = false; }
  }
  if (!ok) redirect(`/${slug}`);
  return <NoteComposerClient slug={slug} />;
}
