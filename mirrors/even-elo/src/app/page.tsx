import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

/**
 * Root route — EPI.0b.
 *
 * Auth-conditional redirect:
 *   logged-in (active) → /home
 *   anything else      → /auth/login
 *
 * Middleware also enforces this for protected routes, but redirecting from /
 * directly is faster + avoids a flash.
 */
export default async function RootRedirect() {
  const user = await getCurrentUser();
  if (user && user.status === "active") {
    redirect("/home");
  }
  redirect("/auth/login");
}
