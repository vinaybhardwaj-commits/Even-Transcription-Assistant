import { portalJson } from "@/lib/portal/forbidden-keys";
import { clearPhysicianCookie } from "@/lib/physician-auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST() { await clearPhysicianCookie(); return portalJson({ ok: true }); }
