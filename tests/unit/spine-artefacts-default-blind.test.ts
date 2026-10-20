/** spine-s3-r4 F2: with no injected days, the index binds the BLIND_ROOM_DAYS constant (the set every room-access reader uses) as $2 of EVERY source page. No docker. */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/rubrics/blind-room-days", () => ({ BLIND_ROOM_DAYS: [["2026-10-01", "room_test_a"], ["2026-10-02", "room_test_b"]] }));
import { indexSpineArtefacts } from "@/lib/spine/artefacts-store";
import { SOURCES } from "@/lib/spine/artefacts";

const NOW = new Date("2026-10-19T10:00:00Z");
describe("spine artefacts: default blind room-days", () => {
  it("binds the constant's date|room keys to all six source pages, and the page SQL carries the room-day predicate", async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const db = async (text: string, params: unknown[] = []): Promise<unknown[]> => {
      seen.push({ text, params });
      return text.startsWith("SELECT value FROM spine_config") && params[0] === "artefacts" ? [{ value: "shadow" }] : [];
    };
    await indexSpineArtefacts(NOW, db);
    const pages = seen.filter((s) => s.text.startsWith("SELECT") && !s.text.startsWith("SELECT value"));
    expect(pages).toHaveLength(SOURCES.length);
    for (const s of pages) {
      expect(s.params[1]).toEqual(["2026-10-01|room_test_a", "2026-10-01|room_scratch_test_a", "2026-10-02|room_test_b", "2026-10-02|room_scratch_test_b"]);   // each real room also lists its scratch twin
      expect(s.params).toHaveLength(2);
      expect(s.text).toMatch(/= ANY\(\$2::text\[\]\)/);
    }
  });
  it("off runs no source read and binds nothing", async () => {
    const seen: string[] = [];
    await indexSpineArtefacts(NOW, async (t) => { seen.push(t); return []; });
    expect(seen).toHaveLength(1);
  });
  it("a failing page query rejects (no catch); blindDays: [] is the explicit empty set", async () => {
    const db = async (t: string, p: unknown[] = []): Promise<unknown[]> => { if (t.startsWith("SELECT value") && p[0] === "artefacts") return [{ value: "live" }]; if (t.startsWith("SELECT value")) return []; throw new Error("neon down"); };
    await expect(indexSpineArtefacts(NOW, db)).rejects.toThrow("neon down");
    const bound: unknown[][] = [];
    await indexSpineArtefacts(NOW, async (t, p = []) => { if (t.startsWith("SELECT value")) return p[0] === "artefacts" ? [{ value: "shadow" }] : []; bound.push(p); return []; }, { blindDays: [] });
    expect(bound.every((p) => (p[1] as unknown[]).length === 0 && p.length === 2)).toBe(true);
  });
});
