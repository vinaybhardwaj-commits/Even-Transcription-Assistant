/**
 * /admin/doctors/[id]/voice — admin kiosk voice enrollment (recording-evidence).
 * Admin-authenticated; enrolls the chosen doctor's voiceprint (doctor present
 * at the admin's mic). Reuses the shared wizard; finishing or "Back to doctors"
 * returns to /admin/doctors.
 */
import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { VoiceEnrollClient } from "@/components/recording/VoiceEnrollClient";

export const dynamic = "force-dynamic";

type Row = { id: string; full_name: string };

export default async function AdminDoctorVoicePage({ params }: { params: Promise<{ id: string }> }) {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  try { await verifyAdminJwt(cookie); } catch { redirect("/admin"); }

  const { id } = await params;
  const rows = (await sql`SELECT id, full_name FROM doctor WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`) as Row[];
  const doctor = rows[0];
  if (!doctor) notFound();

  return (
    <VoiceEnrollClient
      doctorName={doctor.full_name.replace(/^Dr\.?\s+/i, "")}
      context="admin"
      enrollUrl={`/api/admin/doctors/${id}/voice-enroll`}
      doneUrl="/admin/doctors"
      cancelUrl="/admin/doctors"
      transcribeUrl="/api/voice/transcribe-window"
    />
  );
}
