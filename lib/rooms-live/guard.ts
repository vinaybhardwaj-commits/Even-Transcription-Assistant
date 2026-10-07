/**
 * lib/rooms-live/guard.ts — who may use Rooms Live (SPEC-v1 AMENDMENT 2): a valid admin cookie (benchAdminGuard's own check, imported unchanged) OR a valid staff
 * cookie (lib/rooms-live/staff-auth.ts). Returns { kind, name }: the staff member's typed name, or the admin's e-mail local part. The staff cookie is honoured ONLY
 * by /api/rooms-live/* and the /rooms-live page: nothing else imports this file, and benchAdminGuard (used by every /api/admin route) never looks at it.
 */
import { benchAdminGuard } from "@/lib/bench";
import { readStaffCookie, verifyStaffJwt } from "./staff-auth";

export type Who = { kind: "admin" | "staff"; name: string };
export type RoomsLiveGuard = ({ ok: true } & Who) | { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED"; msg: string };

const localPart = (email: unknown): string => {
  const s = typeof email === "string" ? email.split("@")[0]!.trim() : "";
  return (s || "admin").slice(0, 64);
};

export async function roomsLiveGuard(_req?: Request): Promise<RoomsLiveGuard> {
  const admin = await benchAdminGuard();
  if (admin.ok) return { ok: true, kind: "admin", name: localPart((admin.claims as { email?: unknown }).email) };
  const cookie = await readStaffCookie();
  if (cookie) {
    const staff = await verifyStaffJwt(cookie);
    if (staff) return { ok: true, kind: "staff", name: staff.name };
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
  return admin;
}

/** For the page: null = show the login screen. */
export async function roomsLivePageGuard(): Promise<Who | null> {
  const g = await roomsLiveGuard();
  return g.ok ? { kind: g.kind, name: g.name } : null;
}
