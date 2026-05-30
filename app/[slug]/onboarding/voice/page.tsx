import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { parseDoctorSlug } from "@/lib/doctor-slug";
import { VoiceEnrollClient } from "@/components/recording/VoiceEnrollClient";

/** /{slug}/onboarding/voice — V2.SD.1 voice enrollment wizard. */
export const dynamic = "force-dynamic";

type Row = { id: string; full_name: string };

export default async function VoiceOnboardingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!parseDoctorSlug(slug)) notFound();
  const rows = (await sql`
    SELECT id, full_name FROM doctor WHERE url_slug = ${slug} AND deleted_at IS NULL LIMIT 1
  `) as Row[];
  const doctor = rows[0];
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
    <VoiceEnrollClient
      doctorName={doctor.full_name.replace(/^Dr\.?\s+/i, "")}
      context="doctor"
      enrollUrl={`/${slug}/api/voice/enroll`}
      doneUrl={`/${slug}/record`}
      transcribeUrl="/api/voice/transcribe-window"
    />
  );
}
