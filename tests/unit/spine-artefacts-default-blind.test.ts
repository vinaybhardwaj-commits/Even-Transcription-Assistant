/** spine-s3-r3 G1: with no injected lookup, the index asks room-access blindWindowIds and binds its ids as $2 of the room-table sources. No docker. */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/room-access/check", () => ({ blindWindowIds: async () => ["bw_test_blind_1", "bw_test_blind_2"] }));
import { indexSpineArtefacts } from "@/lib/spine/artefacts-store";

describe("spine artefacts: default blind lookup", () => {
  it("binds the room-access blind ids to the reb, nemotron and catalog selects, and to no other source", async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const db = async (text: string, params: unknown[] = []): Promise<unknown[]> => {
      seen.push({ text, params });
      return text.startsWith("SELECT value FROM spine_config") && params[0] === "artefacts" ? [{ value: "shadow" }] : [];
    };
    await indexSpineArtefacts(new Date("2026-10-19T10:00:00Z"), db);
    const withBlind = seen.filter((s) => s.params[1] !== undefined);
    expect(withBlind).toHaveLength(3);
    for (const s of withBlind) expect(s.params[1]).toEqual(["bw_test_blind_1", "bw_test_blind_2"]);
    expect(withBlind.map((s) => /reb_track_index|diarize_nemotron_window/.test(s.text)).every(Boolean)).toBe(true);
    expect(seen.filter((s) => s.text.startsWith("SELECT") && !s.text.startsWith("SELECT value") && s.params.length === 1)).toHaveLength(3);
  });
  it("off runs no blind lookup and no source read", async () => {
    const seen: string[] = [];
    await indexSpineArtefacts(new Date("2026-10-19T10:00:00Z"), async (t) => { seen.push(t); return []; });
    expect(seen).toHaveLength(1);
  });
});
