import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { parseDoctorSlug } from "@/lib/doctor-slug";
import { DoctorPinClient } from "@/components/DoctorPinClient";
import { HomeShell } from "@/components/HomeShell";

/**
 * Doctor entry surface per PRD §8.1.1 + §8.1.2.
 *
 * URL pattern: /dr-{firstname}-{lastname}-{4char-token}
 *   — slug + token combine into a single URL segment.
 *   — slug is the path-component-safe doctor identifier.
 *
 * Probe-proof per PRD §4.14: invalid pattern OR missing doctor row
 *   returns real HTTP 404 (no "doctor not found, did you mean…").
 *
 * Server-side cookie check decides which shell to render:
 *   - No / invalid eta_session cookie → PIN entry
 *   - Valid eta_session                → HomeShell
 */

export const dynamic = "force-dynamic";

type DoctorRow = {
  id: string;
  full_name: string;
  url_slug: string;
  url_token: string;
  pin_hash: string | null;
  status: "active" | "disabled" | "locked";
  clinician_type: string | null;
};

async function findDoctor(fullSlug: string): Promise<DoctorRow | null> {
  // url_slug stores the full slug INCLUDING the token (per PRD §4.14 db note)
  try {
    const rows = (await sql`
      SELECT id, full_name, url_slug, url_token, pin_hash, status,
             (SELECT clinician_type FROM clinician WHERE clinician.id = doctor.id) AS clinician_type
        FROM doctor
       WHERE url_slug = ${fullSlug}
         AND deleted_at IS NULL
       LIMIT 1
    `) as DoctorRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export default async function DoctorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // 1. Pattern guard (probe-proof)
  const parsed = parseDoctorSlug(slug);
  if (!parsed) notFound();

  // 2. Lookup doctor (also probe-proof — same 404 for unknown slug)
  const doctor = await findDoctor(slug);
  if (!doctor) notFound();

  // 3. Cookie check — if valid, render home; otherwise PIN
  const jwt = await readDoctorCookie();
  let authed = false;
  if (jwt) {
    try {
      const claims = await verifyDoctorJwt(jwt);
      if (claims.doctor_id === doctor.id && claims.slug === slug) {
        authed = true;
      }
    } catch {
      // bad/expired cookie — fall through to PIN
    }
  }

  if (authed) {
    let voiceEnrolled = false;
    try {
      const vp = (await sql`SELECT 1 FROM voice_print WHERE doctor_id = ${doctor.id} LIMIT 1`) as Array<unknown>;
      voiceEnrolled = vp.length > 0;
    } catch { /* table may not exist on older deploys */ }
    return <HomeShell slug={slug} doctorName={doctor.full_name} voiceEnrolled={voiceEnrolled} clinicianType={doctor.clinician_type ?? "physician"} />;
  }

  // PIN entry shell
  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12 bg-even-white">
      <div className="w-full max-w-sm">
        <header className="text-center mb-8">
          <h1 className="text-display text-even-navy-800">Even Hospital</h1>
          <p className="mt-1 text-caption text-even-ink-500">Encounter Assistant</p>
        </header>

        <section
          aria-label="PIN entry"
          className="rounded-xl border border-even-ink-100 bg-even-white p-6 shadow-card"
        >
          <DoctorPinClient slug={slug} doctorName={doctor.full_name} />
        </section>

        <p className="mt-6 text-caption text-even-ink-400 text-center">
          By recording, you confirm patient consent has been obtained per your clinic&apos;s policy.
        </p>

        <p className="mt-4 text-caption text-even-ink-500 text-center">
          Forgot PIN? Contact your administrator.
        </p>
      </div>
    </main>
  );
}
