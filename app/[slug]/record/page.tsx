import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { parseDoctorSlug } from "@/lib/doctor-slug";
import { RecordingScreen } from "@/components/recording/RecordingScreen";

/**
 * /{slug}/record — Recording surface per PRD §8.1.3.
 *
 * Guard: same cookie check as /{slug}. No cookie = redirect to PIN entry,
 * because the recording screen is useless without a draft encounter row,
 * and creating one requires an authenticated doctor.
 */

export const dynamic = "force-dynamic";

type Row = { id: string; full_name: string; url_slug: string };

async function findDoctor(fullSlug: string): Promise<Row | null> {
  try {
    const rows = (await sql`
      SELECT id, full_name, url_slug
        FROM clinician
       WHERE url_slug = ${fullSlug}
         AND deleted_at IS NULL
       LIMIT 1
    `) as Row[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export default async function RecordPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (!parseDoctorSlug(slug)) notFound();
  const doctor = await findDoctor(slug);
  if (!doctor) notFound();

  const cookie = await readDoctorCookie();
  if (!cookie) redirect(`/${slug}`);
  try {
    const claims = await verifyDoctorJwt(cookie);
    if (claims.doctor_id !== doctor.id) redirect(`/${slug}`);
  } catch {
    redirect(`/${slug}`);
  }

  return (
    <RecordingScreen
      slug={slug}
      doctorName={doctor.full_name.replace(/^Dr\.?\s+/i, "")}
    />
  );
}
