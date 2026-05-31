import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { parseDoctorSlug } from "@/lib/doctor-slug";
import { RecipientsManager } from "@/components/recipients/RecipientsManager";

export const dynamic = "force-dynamic";

export default async function RecipientsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!parseDoctorSlug(slug)) notFound();
  const cookie = await readDoctorCookie();
  if (!cookie) redirect(`/${slug}`);
  let claims;
  try {
    claims = await verifyDoctorJwt(cookie);
  } catch {
    redirect(`/${slug}`);
  }
  if (claims.slug !== slug) redirect(`/${slug}`);

  // Sanity-check the doctor row exists
  try {
    const rows = (await sql`
      SELECT id FROM clinician WHERE id = ${claims.doctor_id} AND deleted_at IS NULL LIMIT 1
    `) as Array<{ id: string }>;
    if (rows.length === 0) redirect(`/${slug}`);
  } catch {
    notFound();
  }

  return <RecipientsManager slug={slug} />;
}
