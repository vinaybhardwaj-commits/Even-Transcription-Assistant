/**
 * /room/{slug}/api/login is retired: every room now records with the
 * native Room Recorder app, so this endpoint must never mint a room
 * session again — a leftover Chrome tab on a room Mac that still submits
 * a PIN here must get nothing back that could make it a second listener
 * for the room's commands.
 */
import { describe, it, expect } from "vitest";
import * as route from "@/app/room/[slug]/api/login/route";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

describe("retired room login route — GONE for every method", () => {
  for (const method of METHODS) {
    it(`${method} returns 410 with no body and sets no cookie`, async () => {
      const handler = route[method as keyof typeof route] as () => Promise<Response>;
      const res = await handler();
      expect(res.status).toBe(410);
      expect(res.headers.get("set-cookie")).toBeNull();
      const text = await res.text();
      expect(text).toBe("");
    });
  }
});
