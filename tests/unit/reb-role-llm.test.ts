/**
 * Arch #91 — the REB reader joins role.llm-roles onto Sarvam lines behind ETA_REB_ROLE_LLM.
 * Flag off (and a missing role track) must leave the consult object byte-identical. No transcript text is asserted beyond short tokens; the role track's text is a sentinel that must not come back.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsultSpan } from "@/lib/room-access/readers/consult-span";

const H = vi.hoisted(() => ({
  blind: new Set<string>(),
  trackRows: [] as Array<{ layer: string; engine: string; config_hash: string; r2_key: string; sha256: string }>,
  roleRows: [] as Array<{ layer: string; engine: string; config_hash: string; r2_key: string; sha256: string }>,
  queries: [] as string[],
  gets: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    H.queries.push(text);
    if (text.includes("llm-roles")) return H.roleRows;
    return H.trackRows;
  },
}));

vi.mock("@/lib/rubrics/blind-room-days", async (orig) => {
  const actual = await orig<typeof import("@/lib/rubrics/blind-room-days")>();
  return { ...actual, isBlindRoomDay: (d: string, r: string) => H.blind.has(`${String(d).slice(0, 10)}|${r}`) };
});

import { FlagValueError } from "@/lib/flags";
import { setLabStoreForTests } from "@/lib/sarvam-lab";
import { palimpsestAsResult } from "@/lib/consult-index/palimpsest-view";
import {
  indexRoleSegments,
  linesFromTrack,
  lookupRole,
  readRebConsult,
  readRebRoleFlags,
  roleFlagsFromExtras,
  roleSegmentKey,
  speakerRoleMap,
} from "@/lib/room-access/readers/reb-consult";

const UID = "ConsultUidRole1AaaaaaaaaaZ";
const OPEN = 1_700_000_000_000;
const LEAK = "ROLETEXT_LEAK_SENTINEL";
const sha = (b: string): string => createHash("sha256").update(b, "utf8").digest("hex");
const mem = new Map<string, string>();

const span = (over: Partial<ConsultSpan> = {}): ConsultSpan => ({
  consult_key: "enc1@m1", consult_uid: UID, room_id: "r1", t_open_ms: OPEN, t_close_ms: OPEN + 30_000,
  ist_date: "2026-10-08", quality: "ok", attribution: "test", windows: [], ...over,
});

const keyOf = (file: string, date = "2026-10-08", room = "r1", uid = UID) => `reb/${date}/${room}/_consults/${uid}/tracks/${file}.json`;

function seg(at: number, speaker: string, text: string, lang = "en-IN") {
  return { t0_ms: OPEN + at, t1_ms: OPEN + at + 1_500, speaker, lang, text };
}

function sttBody(segments: unknown[]) {
  return JSON.stringify({ config: {}, config_hash: "stt", engine: "sarvam-saaras-v3", extras: {}, layer: "stt", segments, status: "ok", window_id: `consult-${UID}` });
}

function roleBody(segments: unknown[], extras: Record<string, unknown>) {
  return JSON.stringify({
    config: {}, config_hash: "role", engine: "llm-roles", version: "v1", layer: "role", status: "ok",
    window_id: `consult-${UID}`, segments, extras,
  });
}

function put(layer: "stt" | "translate" | "role", cfg: string, body: string, o: { sha256?: string; date?: string; file?: string } = {}) {
  const file = o.file ?? (layer === "role" ? `role.llm-roles__v1__${cfg}` : `${layer}.sarvam-saaras-v3__saaras-v3__${cfg}`);
  const r2_key = keyOf(file, o.date);
  mem.set(r2_key, body);
  const row = { layer, engine: layer === "role" ? "llm-roles" : "sarvam-saaras-v3", config_hash: cfg, r2_key, sha256: o.sha256 ?? sha(body) };
  if (layer === "role") H.roleRows.push(row);
  else H.trackRows.push(row);
  return r2_key;
}

const saved = process.env.ETA_REB_ROLE_LLM;

beforeEach(() => {
  H.blind = new Set();
  H.trackRows = [];
  H.roleRows = [];
  H.queries = [];
  H.gets = [];
  mem.clear();
  delete process.env.ETA_REB_ROLE_LLM;
  setLabStoreForTests({
    get: async (k) => { H.gets.push(k); return mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null; },
    put: async () => "ok",
    list: async () => [],
  });
});

afterEach(() => {
  setLabStoreForTests(null);
  if (saved === undefined) delete process.env.ETA_REB_ROLE_LLM;
  else process.env.ETA_REB_ROLE_LLM = saved;
});

describe("pure role join", () => {
  const open = OPEN;
  const doc = {
    status: "ok",
    segments: [
      seg(1000, "0", "alpha"),
      seg(4000, "1", "beta"),
      seg(7000, "2", "gamma"),
      seg(10000, "3", "delta"),
      seg(13000, "4", "epsilon"),
      seg(16000, "5", "zeta"),
    ],
  };
  const roles = indexRoleSegments([
    { t0_ms: OPEN + 1000, t1_ms: OPEN + 2500, speaker: "0", role: "doctor", text: LEAK },
    { t0_ms: OPEN + 4000, t1_ms: OPEN + 5500, speaker: "1", role: "attender", text: LEAK },
    { t0_ms: OPEN + 7000, t1_ms: OPEN + 8500, speaker: "2", role: "patient" },
    { t0_ms: OPEN + 10000, t1_ms: OPEN + 11500, speaker: "3", role: "nurse" },
    { t0_ms: OPEN + 90000, t1_ms: OPEN + 91000, speaker: "9", role: "staff", text: LEAK },
  ]);

  it("joins on (t0_ms, t1_ms, speaker) exactly: doctor, attender, patient, an unknown role, a missing segment, and an extra role segment is ignored", () => {
    expect(roleSegmentKey(OPEN + 1000, OPEN + 2500, 0)).toBe(roleSegmentKey(OPEN + 1000, OPEN + 2500, "0"));
    // The stt reader passes bySegment only. A caller that also passes bySpeaker uses it solely for a segment the exact key missed.
    const got = linesFromTrack(doc, open, open + 30_000, "stt", { bySegment: roles, bySpeaker: speakerRoleMap({ map: { "4": "staff", "5": LEAK } }) })!;
    const strict = linesFromTrack(doc, open, open + 30_000, "stt", { bySegment: roles })!;
    expect(strict.lines.map((l) => ({ speaker: l.speaker, role: l.role, speaker_idx: l.speaker_idx, text: l.text }))).toEqual([
      { speaker: "doctor", role: "doctor", speaker_idx: 0, text: "alpha" },
      { speaker: "other", role: "attender", speaker_idx: 1, text: "beta" },
      { speaker: "other", role: "patient", speaker_idx: 2, text: "gamma" },
      { speaker: "unknown", role: "unknown", speaker_idx: 3, text: "delta" },
      { speaker: "unknown", role: "unknown", speaker_idx: 4, text: "epsilon" },
      { speaker: "unknown", role: "unknown", speaker_idx: 5, text: "zeta" },
    ]);
    expect(strict.lines).toHaveLength(doc.segments.length); // the extra role segment did not become a line
    expect(strict.turns.map((t) => ({ role: t.role, reb_role: t.reb_role }))).toEqual([
      { role: "clinician", reb_role: "doctor" },
      { role: null, reb_role: "attender" },
      { role: null, reb_role: "patient" },
      { role: null, reb_role: "unknown" },
      { role: null, reb_role: "unknown" },
      { role: null, reb_role: "unknown" },
    ]);
    expect(JSON.stringify(strict)).not.toContain(LEAK);
    expect(got.lines[4]!.role).toBe("staff"); // bySpeaker is a fallback only when the caller passes it
    expect(got.lines[5]!.role).toBe("unknown"); // a map value that is not a role becomes unknown, and the sentinel is not copied
    expect(JSON.stringify(got)).not.toContain(LEAK);
  });

  it("maps staff and other onto speaker other, and the first role segment for a key wins", () => {
    const segs = [
      { t0_ms: 10, t1_ms: 20, speaker: "7", role: "staff" },
      { t0_ms: 10, t1_ms: 20, speaker: "7", role: "doctor" },
      { t0_ms: 30, t1_ms: 40, speaker: "8", role: "other" },
    ];
    const map = indexRoleSegments(segs);
    expect(lookupRole({ bySegment: map }, 10, 20, "7")).toBe("staff");
    const built = linesFromTrack({
      status: "ok",
      segments: [
        { t0_ms: OPEN + 10, t1_ms: OPEN + 20, speaker: "7", lang: "en", text: "forms" },
        { t0_ms: OPEN + 30, t1_ms: OPEN + 40, speaker: "8", lang: "en", text: "aside" },
      ],
    }, OPEN, OPEN + 100, "stt", { bySegment: indexRoleSegments(segs.map((s) => ({ ...s, t0_ms: OPEN + s.t0_ms, t1_ms: OPEN + s.t1_ms }))) })!;
    expect(built.lines.map((l) => [l.speaker, l.role])).toEqual([["other", "staff"], ["other", "other"]]);
    expect(built.turns.every((t) => t.role === null)).toBe(true);
  });

  it("without a role lookup the objects have no role and no reb_role (the pre-change shape)", () => {
    const bare = linesFromTrack(doc, open, open + 30_000, "stt")!;
    expect(bare.lines[0]).toEqual({ t_ms: 1000, speaker: "unknown", speaker_idx: 0, text: "alpha" });
    expect(bare.turns[0]).toEqual({ source_ref: "reb0", start_ms: 1000, end_ms: 2500, speaker_idx: 0, role: null, overlap_ms: null });
    expect(bare.lines[0]).not.toHaveProperty("role");
    expect(bare.turns[0]).not.toHaveProperty("reb_role");
  });
});

describe("role flags (counts only)", () => {
  it("reads attender_present, two_consults.flag and diar_partial, and does not read text", () => {
    const extras = { map: { "0": "doctor" }, attender_present: true, two_consults: { flag: false, gap_at_s: 12 }, diar_partial: true, prompt: LEAK, note: LEAK };
    expect(roleFlagsFromExtras(extras)).toEqual({ attender_present: true, two_consults: false, diar_partial: true });
    expect(JSON.stringify(roleFlagsFromExtras(extras))).not.toContain(LEAK);
    expect(roleFlagsFromExtras({ two_consults: true, attender_present: LEAK, diar_partial: "no" })).toEqual({ attender_present: null, two_consults: true, diar_partial: null });
    expect(roleFlagsFromExtras({ map: { "0": "doctor" }, prompt: LEAK })).toBeNull();
    expect(roleFlagsFromExtras(null)).toBeNull();
  });

  it("palimpsestAsResult attaches the three flags only when they are passed", () => {
    const row = { consult_uid: UID, cut_version: "v", t0_ms: OPEN, t1_ms: OPEN + 1000 };
    const stt = { layer: "stt" as const, engine: "sarvam-saaras-v3", model: "saaras:v3", version: "v", config_hash: "h", r2_key: "k", segments: [{ t0_ms: OPEN, t1_ms: OPEN + 1000, speaker: "0", lang: "en", text: "alpha" }] };
    const plain = palimpsestAsResult(row, stt, null);
    expect(plain.result).not.toHaveProperty("reb_role_flags");
    const flagged = palimpsestAsResult(row, stt, null, { attender_present: true, two_consults: false, diar_partial: false });
    expect(flagged.result.reb_role_flags).toEqual({ attender_present: true, two_consults: false, diar_partial: false });
    expect(flagged.doc.entries[0]).not.toHaveProperty("role");
    expect(JSON.stringify(flagged)).not.toContain(LEAK);
  });
});

describe("readRebConsult", () => {
  const segments = [
    seg(1000, "0", "alpha"),
    seg(4000, "1", "beta"),
    seg(7000, "2", "gamma"),
    seg(10000, "3", "delta"),
    seg(13000, "4", "epsilon"),
  ];

  function install(roleExtras?: Record<string, unknown>, roleSegments?: unknown[]) {
    put("stt", "sttcfg01", sttBody(segments));
    const segs = roleSegments ?? [
      { t0_ms: OPEN + 1000, t1_ms: OPEN + 2500, speaker: "0", role: "doctor", text: LEAK },
      { t0_ms: OPEN + 4000, t1_ms: OPEN + 5500, speaker: "1", role: "attender", text: LEAK },
      { t0_ms: OPEN + 7000, t1_ms: OPEN + 8500, speaker: "2", role: "patient" },
      { t0_ms: OPEN + 10000, t1_ms: OPEN + 11500, speaker: "3", role: "not-a-role" },
      { t0_ms: OPEN + 90000, t1_ms: OPEN + 91500, speaker: "9", role: "staff", text: LEAK },
    ];
    put("role", "rolecfg1", roleBody(segs, roleExtras ?? {
      map: { "0": "doctor", "1": "attender", "4": "staff" },
      attender_present: true, two_consults: { flag: true }, diar_partial: false, prompt: LEAK,
    }));
  }

  it("flag off is byte-identical to a consult with no role track, and the role object is not fetched", async () => {
    install();
    const off = await readRebConsult(span());
    const roleKey = H.roleRows[0]!.r2_key;
    expect(H.gets).not.toContain(roleKey);
    expect(H.queries.some((q) => q.includes("llm-roles"))).toBe(false);
    H.roleRows = [];
    H.gets = [];
    H.queries = [];
    const bare = await readRebConsult(span());
    expect(JSON.stringify(off)).toBe(JSON.stringify(bare));
    expect(off.found).not.toHaveProperty("role_source");
    expect(off.found?.lines[0]).toEqual({ t_ms: 1000, speaker: "unknown", speaker_idx: 0, text: "alpha" });
    expect(off.found?.lines.every((l) => l.speaker === "unknown" && !("role" in l))).toBe(true);
    expect(off.found?.turns.every((t) => t.role === null && !("reb_role" in t))).toBe(true);
  });

  it("flag on maps speakers, keeps Turn.role as clinician only for doctor, and never returns role-track text", async () => {
    process.env.ETA_REB_ROLE_LLM = "on";
    install();
    const got = await readRebConsult(span());
    expect(got.found).toMatchObject({ source: "reb_stt_en", config_hash: "sttcfg01", role_source: "reb_llm_roles", role_config_hash: "rolecfg1", n_integrity_skipped: 0 });
    expect(got.found?.lines.map((l) => ({ speaker: l.speaker, role: l.role, text: l.text }))).toEqual([
      { speaker: "doctor", role: "doctor", text: "alpha" },
      { speaker: "other", role: "attender", text: "beta" },
      { speaker: "other", role: "patient", text: "gamma" },
      { speaker: "unknown", role: "unknown", text: "delta" },
      { speaker: "unknown", role: "unknown", text: "epsilon" }, // in extras.map as staff, but stt join is exact: a missing segment stays unknown
    ]);
    expect(got.found?.turns[0]).toMatchObject({ role: "clinician", reb_role: "doctor" });
    expect(got.found?.turns[1]).toMatchObject({ role: null, reb_role: "attender" });
    expect(JSON.stringify(got)).not.toContain(LEAK);
    expect(H.queries.some((q) => q.includes("layer = 'role'") && q.includes("engine = 'llm-roles'") && q.includes("shadow = false") && q.includes("status = 'ok'"))).toBe(true);
    expect(await readRebRoleFlags(UID, "r1", "r1")).toEqual({ attender_present: true, two_consults: true, diar_partial: false });
  });

  it("a missing role track leaves the flag-on output identical to flag off", async () => {
    put("stt", "sttcfg01", sttBody(segments));
    process.env.ETA_REB_ROLE_LLM = "1";
    const on = await readRebConsult(span());
    delete process.env.ETA_REB_ROLE_LLM;
    H.queries = [];
    const off = await readRebConsult(span());
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(on.found).not.toHaveProperty("role_source");
  });

  it("a sha256 mismatch is skipped and counted, and an older matching role track is used", async () => {
    process.env.ETA_REB_ROLE_LLM = "true";
    put("stt", "sttcfg01", sttBody([seg(1000, "0", "alpha")]));
    const good = roleBody([{ t0_ms: OPEN + 1000, t1_ms: OPEN + 2500, speaker: "0", role: "doctor" }], { attender_present: false, two_consults: false, diar_partial: false });
    put("role", "newerbad", good, { sha256: "deadbeef" }); // newest row (first), bytes do not match
    put("role", "olderok1", good);
    const got = await readRebConsult(span());
    expect(got.found).toMatchObject({ role_source: "reb_llm_roles", role_config_hash: "olderok1", n_integrity_skipped: 1 });
    expect(got.found?.lines[0]).toMatchObject({ speaker: "doctor", role: "doctor" });
  });

  it("a sha256 mismatch with no older track is counted and the lines stay unlabeled", async () => {
    process.env.ETA_REB_ROLE_LLM = "yes";
    put("stt", "sttcfg01", sttBody([seg(1000, "0", "alpha")]));
    put("role", "rolecfg1", roleBody([{ t0_ms: OPEN + 1000, t1_ms: OPEN + 2500, speaker: "0", role: "doctor" }], {}), { sha256: "00" });
    const got = await readRebConsult(span());
    expect(got.n_integrity_skipped).toBe(1);
    expect(got.found).not.toHaveProperty("role_source");
    expect(got.found?.lines[0]).toEqual({ t_ms: 1000, speaker: "unknown", speaker_idx: 0, text: "alpha" });
  });

  it("a held-out span is refused before any fetch", async () => {
    process.env.ETA_REB_ROLE_LLM = "1";
    install();
    H.blind.add("2026-10-08|r1");
    H.gets = [];
    H.queries = [];
    const got = await readRebConsult(span());
    expect(got).toEqual({ found: null, n_integrity_skipped: 0 });
    expect(H.gets).toEqual([]);
    expect(H.queries).toEqual([]);
  });

  it("a role key on a held-out room-day is skipped and counted, and its object is not fetched", async () => {
    process.env.ETA_REB_ROLE_LLM = "1";
    put("stt", "sttcfg01", sttBody([seg(1000, "0", "alpha")]));
    const roleKey = put("role", "rolecfg1", roleBody([{ t0_ms: OPEN + 1000, t1_ms: OPEN + 2500, speaker: "0", role: "doctor" }], { attender_present: true }), { date: "2026-09-13" });
    H.blind.add("2026-09-13|r1");
    const got = await readRebConsult(span());
    expect(H.gets).not.toContain(roleKey);
    expect(got.n_integrity_skipped).toBe(1);
    expect(got.found).not.toHaveProperty("role_source");
    expect(got.found?.lines[0]?.speaker).toBe("unknown");
  });

  it("a translate track uses the speaker map when times do not match, and an exact segment still wins", async () => {
    process.env.ETA_REB_ROLE_LLM = "1";
    const translated = [
      { t0_ms: OPEN + 1000, t1_ms: OPEN + 2500, speaker: "0", lang: "en-IN", text: "alpha-en" }, // same times as the role segment
      { t0_ms: OPEN + 5000, t1_ms: OPEN + 6000, speaker: "1", lang: "en-IN", text: "beta-en" }, // different times
    ];
    put("translate", "trcfg001", JSON.stringify({ status: "ok", layer: "translate", engine: "sarvam-saaras-v3", segments: translated, extras: {} }));
    put("role", "rolecfg1", roleBody(
      [{ t0_ms: OPEN + 1000, t1_ms: OPEN + 2500, speaker: "0", role: "doctor", text: LEAK }],
      { map: { "0": "patient", "1": "attender" }, attender_present: true, two_consults: { flag: false }, diar_partial: true, prompt: LEAK },
    ));
    const got = await readRebConsult(span());
    expect(got.found).toMatchObject({ source: "reb_translate", role_source: "reb_llm_roles" });
    expect(got.found?.lines.map((l) => [l.speaker, l.role, l.text])).toEqual([
      ["doctor", "doctor", "alpha-en"], // exact segment (a fix) beats extras.map patient
      ["other", "attender", "beta-en"],
    ]);
    expect(got.found?.turns[1]).toMatchObject({ role: null, reb_role: "attender" });
    expect(JSON.stringify(got)).not.toContain(LEAK);
  });

  describe("stt layer takes the newest wholly-English row", () => {
    const en = [seg(1000, "0", "alpha"), seg(4000, "1", "beta")];
    const native = [seg(1000, "0", "alpha-native", "hi-IN"), seg(4000, "1", "beta-native", "hi-IN")];
    const langless = en.map((g) => { const { lang: _l, ...rest } = g; return rest; });

    it("a newer lang-less stt row is skipped and the older wholly-English row is used and named", async () => {
      put("stt", "newmedas", sttBody(langless)); // newest (first)
      put("stt", "oldsarv1", sttBody(en));
      const got = await readRebConsult(span());
      expect(got.found).toMatchObject({ source: "reb_stt_en", config_hash: "oldsarv1" });
      expect(got.found?.lines.map((l) => l.text)).toEqual(["alpha", "beta"]);
    });

    it("a newer native stt row is skipped the same way", async () => {
      put("stt", "newnativ", sttBody(native));
      put("stt", "oldsarv1", sttBody(en));
      const got = await readRebConsult(span());
      expect(got.found).toMatchObject({ source: "reb_stt_en", config_hash: "oldsarv1" });
    });

    it("a newer wholly-English row wins over an older one", async () => {
      put("stt", "newen001", sttBody(en));
      put("stt", "oldsarv1", sttBody(en));
      expect((await readRebConsult(span())).found?.config_hash).toBe("newen001");
    });

    it("every stt row native or lang-less: nothing found, so the caller falls through to window_english", async () => {
      put("stt", "newmedas", sttBody(langless));
      put("stt", "oldnativ", sttBody(native));
      const got = await readRebConsult(span());
      expect(got.found).toBeNull();
    });

    it("a translate track is still used ahead of any stt row", async () => {
      put("stt", "newmedas", sttBody(langless));
      put("stt", "oldsarv1", sttBody(en));
      put("translate", "trcfg001", JSON.stringify({ status: "ok", layer: "translate", engine: "sarvam-saaras-v3", segments: en, extras: {} }));
      const got = await readRebConsult(span());
      expect(got.found).toMatchObject({ source: "reb_translate", config_hash: "trcfg001" });
    });
  });

  it("an unrecognised flag value throws and is not read as off", async () => {
    put("stt", "sttcfg01", sttBody([seg(1000, "0", "alpha")]));
    process.env.ETA_REB_ROLE_LLM = "maybe";
    await expect(readRebConsult(span())).rejects.toBeInstanceOf(FlagValueError);
  });

  it("flag off, readRebRoleFlags does not touch the index", async () => {
    install();
    H.queries = [];
    expect(await readRebRoleFlags(UID, "r1")).toBeNull();
    expect(H.queries).toEqual([]);
  });
});
