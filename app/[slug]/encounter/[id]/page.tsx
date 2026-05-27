import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { parseDoctorSlug } from "@/lib/doctor-slug";
import { EncounterDetailClient } from "@/components/encounter/EncounterDetailClient";
import type { EncounterNote } from "@/lib/note-generation";
import type { CdmssOutput } from "@/lib/cdmss-stub";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  doctor_id: string;
  status: "draft" | "processing" | "complete" | "failed" | "deleted";
  transcript_raw: string | null;
  note_json: EncounterNote | null;
  note_json_edited: EncounterNote | null;
  cdmss_json: CdmssOutput | null;
  send_status: "pending" | "sent" | "failed";
  sent_at: Date | null;
};

type DoctorRow = { full_name: string; email: string };

type SendEventRow = {
  id: string;
  recipient_email: string;
  status: string;
  subject_rendered: string;
  created_at: Date;
};

export default async function EncounterPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;

  if (!parseDoctorSlug(slug)) notFound();
  if (!id.startsWith("enc_")) notFound();

  const cookie = await readDoctorCookie();
  if (!cookie) redirect(`/${slug}`);
  let claims;
  try {
    claims = await verifyDoctorJwt(cookie);
  } catch {
    redirect(`/${slug}`);
  }
  if (claims.slug !== slug) redirect(`/${slug}`);

  let row: Row | undefined;
  let doctor: DoctorRow | undefined;
  let sendEvents: SendEventRow[] = [];
  try {
    const [encRows, docRows, eventRows] = await Promise.all([
      sql`
        SELECT id, doctor_id, status, transcript_raw, note_json,
               note_json_edited, cdmss_json, send_status, sent_at
          FROM encounter
         WHERE id = ${id} AND deleted_at IS NULL
         LIMIT 1
      `,
      sql`SELECT full_name, email FROM doctor WHERE id = ${claims.doctor_id} LIMIT 1`,
      sql`
        SELECT id, recipient_email, status, subject_rendered, created_at
          FROM send_event
         WHERE encounter_id = ${id}
         ORDER BY created_at DESC
      `,
    ]);
    row = (encRows as Row[])[0];
    doctor = (docRows as DoctorRow[])[0];
    sendEvents = eventRows as SendEventRow[];
  } catch {
    notFound();
  }
  if (!row) notFound();
  if (row.doctor_id !== claims.doctor_id) notFound();
  if (!doctor) notFound();

  return (
    <EncounterDetailClient
      slug={slug}
      doctorEmail={doctor.email}
      doctorName={doctor.full_name}
      initial={{
        id: row.id,
        status: row.status,
        note: row.note_json_edited ?? row.note_json,
        cdmss: row.cdmss_json,
        transcript: row.transcript_raw,
        sendStatus: row.send_status,
        sentAt: row.sent_at ? row.sent_at.toISOString() : null,
        sendEvents: sendEvents.map((e) => ({
          id: e.id,
          recipient_email: e.recipient_email,
          status: e.status,
          subject: e.subject_rendered,
          created_at: e.created_at.toISOString(),
        })),
      }}
    />
  );
}
