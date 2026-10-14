import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician, createPhysicianToken, setPhysicianCookie, hashPortalPin, isValidPin } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function POST(req: NextRequest) {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const { new_pin } = (await req.json().catch(() => ({}))) as { new_pin?: string };
  if (!new_pin || !isValidPin(new_pin)) return portalJson({ ok: false, error: "PIN must be exactly 4 digits" }, { status: 400, headers: NO_STORE });
  // Forced first-login change must move OFF the issued default; don't let it be re-set to 0000.
  if (new_pin === "0000") return portalJson({ ok: false, error: "Please choose a PIN other than the default 0000." }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const hash = await hashPortalPin(new_pin);
  await sql`UPDATE physicians SET portal_pin_hash = ${hash}, portal_must_change_pin = false, updated_at = NOW() WHERE id = ${me.physicianId}::uuid`;

  const token = await createPhysicianToken({ kind: "physician", physicianId: me.physicianId, email: me.email, full_name: me.full_name, portal_must_change_pin: false });
  await setPhysicianCookie(token);
  return portalJson({ ok: true }, { headers: NO_STORE });
}
