/**
 * /encounter/[id] — bare encounter deep-link.
 *
 * Older email templates linked to `${appUrl}/encounter/{id}` without the
 * doctor's slug, which 404'd because the real route is
 * `/[slug]/encounter/[id]`. This page exists for backward compatibility:
 * given just the encounter id, we look up its doctor's url_slug and
 * 307-redirect to the doctor-scoped route. The doctor-scoped page then
 * applies its normal PIN auth flow.
 *
 * If the encounter doesn't exist (or was deleted), we 404.
 *
 * Refs ETA-BUG-LOG.md#B9.
 */
import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

type LookupRow = { url_slug: string };

export default async function EncounterDeepLink(
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id.startsWith("enc_")) notFound();

  let rows: LookupRow[] = [];
  try {
    rows = (await sql`
      SELECT d.url_slug
        FROM encounter e
        JOIN clinician d ON d.id = e.doctor_id
       WHERE e.id = ${id} AND e.deleted_at IS NULL
       LIMIT 1
    `) as LookupRow[];
  } catch {
    notFound();
  }
  const slug = rows[0]?.url_slug;
  if (!slug) notFound();

  redirect(`/${slug}/encounter/${id}`);
}
