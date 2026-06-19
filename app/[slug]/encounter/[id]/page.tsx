import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { parseDoctorSlug } from "@/lib/doctor-slug";
import { EncounterDetailClient } from "@/components/encounter/EncounterDetailClient";
import type { AnyNote } from "@/lib/note-generation";
import type { NativeAnalysis } from "@/lib/stt/indic-comprehension";
type ProcStage = { id: string; label: string; state: string };
import type { CdmssOutput } from "@/lib/cdmss-stub";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  doctor_id: string;
  status: "draft" | "processing" | "complete" | "failed" | "deleted" | "draft_partial";
  transcript_raw: string | null;
  transcript_original: string | null;
  detected_language: string | null;
  native_analysis: unknown | null;
  native_analysis_lang: string | null;
  processing_pct: number | null;
  processing_stages: unknown | null;
  speakers: unknown[] | null;
  tagged_transcript: unknown[] | null;
  diarize_status: string | null;
  transcript_flag: string | null;
  transcript_flag_reason: string | null;
  note_type: string | null;
  input_mode: string | null;
  note_json: AnyNote | null;
  note_json_edited: AnyNote | null;
  cdmss_json: CdmssOutput | null;
  send_status: "pending" | "sent" | "failed";
  sent_at: string | Date | null;
};

type DoctorRow = { full_name: string; email: string };

type SendEventRow = {
  id: string;
  recipient_email: string;
  status: string;
  subject_rendered: string;
  created_at: string | Date;
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
        SELECT id, doctor_id, status, transcript_raw, transcript_original, detected_language, native_analysis, native_analysis_lang, processing_pct, processing_stages, speakers, tagged_transcript, diarize_status, transcript_flag, transcript_flag_reason, note_type, input_mode, note_json,
               note_json_edited, cdmss_json, send_status, sent_at
          FROM encounter
         WHERE id = ${id} AND deleted_at IS NULL
         LIMIT 1
      `,
      sql`SELECT full_name, email FROM clinician WHERE id = ${claims.doctor_id} LIMIT 1`,
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
        noteType: row.note_type ?? undefined,
        inputMode: row.input_mode ?? undefined,
        cdmss: row.cdmss_json,
        transcript: row.transcript_raw,
        transcriptOriginal: row.transcript_original,
        detectedLanguage: row.detected_language,
        nativeAnalysis: (row.native_analysis as NativeAnalysis | null) ?? null,
        nativeAnalysisLang: row.native_analysis_lang,
        processingPct: row.processing_pct,
        processingStages: (row.processing_stages as ProcStage[] | null) ?? null,
        speakers: row.speakers,
        taggedTranscript: row.tagged_transcript,
        diarizeStatus: row.diarize_status,
        transcriptFlag: row.transcript_flag,
        transcriptFlagReason: row.transcript_flag_reason,
        sendStatus: row.send_status,
        sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
        sendEvents: sendEvents.map((e) => ({
          id: e.id,
          recipient_email: e.recipient_email,
          status: e.status,
          subject: e.subject_rendered,
          created_at: new Date(e.created_at).toISOString(),
        })),
      }}
    />
  );
}
