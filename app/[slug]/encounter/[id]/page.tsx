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
  cdmss_json: CdmssOutput | null;
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
  try {
    const rows = (await sql`
      SELECT id, doctor_id, status, transcript_raw, note_json, cdmss_json
        FROM encounter
       WHERE id = ${id} AND deleted_at IS NULL
       LIMIT 1
    `) as Row[];
    row = rows[0];
  } catch {
    notFound();
  }
  if (!row) notFound();
  if (row.doctor_id !== claims.doctor_id) notFound();

  return (
    <EncounterDetailClient
      slug={slug}
      initial={{
        id: row.id,
        status: row.status,
        note: row.note_json,
        cdmss: row.cdmss_json,
        transcript: row.transcript_raw,
      }}
    />
  );
}
