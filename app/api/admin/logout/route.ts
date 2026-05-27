import { cookies } from "next/headers";
import { ADMIN_COOKIE } from "@/lib/auth";
import { respondOk } from "@/lib/respond";

export const runtime = "nodejs";

export async function POST() {
  const c = await cookies();
  c.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return respondOk({ ok: true });
}
