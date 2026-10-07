/**
 * lib/rooms-live/guard.ts — who is using Rooms Live. ACCESS IS OPEN by owner ruling 8 Oct 2026: the page and /api/rooms-live/* need no login and no PIN.
 * Identity is still resolved when a cookie is present, so claims keep a real name: a valid admin cookie (benchAdminGuard's own check, imported unchanged) -> kind "admin",
 * named by the e-mail local part; a valid staff cookie (lib/rooms-live/staff-auth.ts) -> kind "staff", the typed name; anybody else (no cookie, or an invalid/expired one)
 * -> kind "open", name "staff" (the claims route lets an open caller supply a display name). The guard therefore never denies. The staff cookie is honoured ONLY
 * by /api/rooms-live/* and the /rooms-live page: nothing else imports this file, and benchAdminGuard (used by every /api/admin route) never looks at it.
 */
import { benchAdminGuard } from "@/lib/bench";
import { readStaffCookie, verifyStaffJwt } from "./staff-auth";

export type Who = { kind: "admin" | "staff" | "open"; name: string };
export type RoomsLiveGuard = { ok: true } & Who;

const localPart = (email: unknown): string => {
  const s = typeof email === "string" ? email.split("@")[0]!.trim() : "";
  return (s || "admin").slice(0, 64);
};

export async function roomsLiveGuard(_req?: Request): Promise<RoomsLiveGuard> {
  try {
    const admin = await benchAdminGuard();
    if (admin.ok) return { ok: true, kind: "admin", name: localPart((admin.claims as { email?: unknown }).email) };
  } catch {
    /* an unreadable admin cookie is just "not an admin" */
  }
  try {
    const cookie = await readStaffCookie();
    if (cookie) {
      const staff = await verifyStaffJwt(cookie);
      if (staff) return { ok: true, kind: "staff", name: staff.name };
    }
  } catch {
    /* an unreadable staff cookie is just "not staff" */
  }
  return { ok: true, kind: "open", name: "staff" };
}

/** For the page: always a Who (access is open). */
export async function roomsLivePageGuard(): Promise<Who> {
  const g = await roomsLiveGuard();
  return { kind: g.kind, name: g.name };
}
