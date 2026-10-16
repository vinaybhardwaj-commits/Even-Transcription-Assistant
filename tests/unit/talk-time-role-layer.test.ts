/**
 * TALKTIME-ROLE-LAYER — talk_time takes doctor / other from the REB role layer (role.llm-roles), never from room_turn_speaker (VP-ACC-01).
 * Fixture style of reb-role-llm.test.ts: the index and the lab store are mocked; readWindowTurns is a spy that must stay at 0 calls.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  trackRows: [] as Array<Record<string, string>>,
  roleRows: [] as Array<Record<string, string>>,
  windowReads: 0,
}));

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray) => (strings.join(" ").includes("llm-roles") ? H.roleRows : H.trackRows),
}));

const UID = "ConsultUidTalk1Aaaaaaaaaaa";
const OPEN = 1_700_000_000_000;
const SPAN = { consult_key: "enc1@m1", consult_uid: UID, room_id: "r1", t_open_ms: OPEN, t_close_ms: OPEN + 30_000, ist_date: "2026-10-08", quality: "ok", attribution: "test", windows: [{ window_id: "w1" }] };

vi.mock("@/lib/rubrics/readers", async (orig) => {
  const actual = await orig<typeof import("@/lib/rubrics/readers")>();
  return {
    ...actual,
    windowPair: async () => ({ room_id: "r1", ist_date: "2026-10-08" }),
    consultPair: async () => ({ room_id: "r1", ist_date: "2026-10-08" }),
    readConsultSpan: async () => ({ ok: true, data: SPAN }),
    readWindowTurns: async () => { H.windowReads += 1; return { ok: false, reason: "no_data" }; },
  };
});

import { setLabStoreForTests } from "@/lib/sarvam-lab";
import { evaluateUnit } from "@/lib/room-access/rubric-engines";
import { getRubric } from "@/lib/rubrics/registry";

const LEAK = "TALKTEXT_LEAK_SENTINEL";
const sha = (b: string): string => createHash("sha256").update(b, "utf8").digest("hex");
const mem = new Map<string, string>();
const keyOf = (file: string) => `reb/2026-10-08/r1/_consults/${UID}/tracks/${file}.json`;
const seg = (at: number, ms: number, speaker: string) => ({ t0_ms: OPEN + at, t1_ms: OPEN + at + ms, speaker, lang: "en-IN", text: LEAK });

function put(layer: "stt" | "role", body: unknown, o: { sha256?: string } = {}) {
  const text = JSON.stringify(body);
  const r2_key = keyOf(layer === "role" ? "role.llm-roles__v1__rolecfg" : "stt.sarvam-saaras-v3__saaras-v3__sttcfg");
  mem.set(r2_key, text);
  const row = { layer, engine: layer === "role" ? "llm-roles" : "sarvam-saaras-v3", config_hash: layer === "role" ? "rolecfg" : "sttcfg", r2_key, sha256: o.sha256 ?? sha(text) };
  (layer === "role" ? H.roleRows : H.trackRows).push(row);
}

// doctor 0-6 s (6 s), patient 6-9 s (3 s), attender 9-10 s (1 s), staff 10-11 s (1 s), unknown 11-12 s (1 s, unattributed)
const SEGS = [seg(0, 6000, "0"), seg(6000, 3000, "1"), seg(9000, 1000, "2"), seg(10_000, 1000, "3"), seg(11_000, 1000, "4")];
const STT = { config: {}, config_hash: "sttcfg", engine: "sarvam-saaras-v3", extras: {}, layer: "stt", status: "ok", window_id: `consult-${UID}`, segments: SEGS };
const ROLE = (roles: string[]) => ({ config: {}, config_hash: "rolecfg", engine: "llm-roles", version: "v1", layer: "role", status: "ok", window_id: `consult-${UID}`, extras: {}, segments: SEGS.map((g, i) => ({ t0_ms: g.t0_ms, t1_ms: g.t1_ms, speaker: g.speaker, role: roles[i] })) });

const tt = () => getRubric("talk_time")!;
const saved = process.env.ETA_REB_ROLE_LLM;

beforeEach(() => {
  H.trackRows = []; H.roleRows = []; H.windowReads = 0; mem.clear();
  delete process.env.ETA_REB_ROLE_LLM;
  setLabStoreForTests({ get: async (k) => (mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null), put: async () => "ok", list: async () => [] });
});
afterEach(() => {
  setLabStoreForTests(null);
  if (saved === undefined) delete process.env.ETA_REB_ROLE_LLM; else process.env.ETA_REB_ROLE_LLM = saved;
});

describe("talk_time consult unit reads the role layer", () => {
  it("maps doctor / patient / attender / staff / unknown and computes the doctor share", async () => {
    put("stt", STT);
    put("role", ROLE(["doctor", "patient", "attender", "staff", "unknown"]));
    const out = await evaluateUnit(tt(), "consult", "enc1@m1");
    expect(out.status).toBe("ok");
    expect(out.score).toMatchObject({ doctor_talk_ms: 6000, other_talk_ms: 5000, unattributed_talk_ms: 1000, doctor_turns: 1, other_turns: 3, unattributed_turns: 1 });
    expect(out.score!.doctor_share).toBeCloseTo(6 / 11, 3);
    expect(out.evidence).toMatchObject({ consult_key: "enc1@m1", turns: 5, role_source: "reb:llm-roles", n_unknown_role: 1, role_config_hash: "rolecfg", n_integrity_skipped: 0 });
    expect(H.windowReads).toBe(0);
  });

  it("ETA_REB_ROLE_LLM off (unset) still joins; evidence and score carry no text and no uid", async () => {
    put("stt", STT);
    put("role", ROLE(["doctor", "patient", "patient", "patient", "patient"]));
    const out = await evaluateUnit(tt(), "consult", "enc1@m1");
    expect(out.status).toBe("ok");
    const blob = JSON.stringify(out);
    expect(blob).not.toContain(LEAK);
    expect(blob).not.toContain(UID);
  });

  it("no role track -> skipped no_role_layer, and room_turn_speaker (readWindowTurns) is never read", async () => {
    put("stt", STT);
    const out = await evaluateUnit(tt(), "consult", "enc1@m1");
    expect(out).toMatchObject({ status: "skipped", reason: "no_role_layer" });
    expect(H.windowReads).toBe(0);
  });

  it("role track sha mismatch -> no_role_layer, counted", async () => {
    put("stt", STT);
    put("role", ROLE(["doctor", "patient", "attender", "staff", "unknown"]), { sha256: "0".repeat(64) });
    const out = await evaluateUnit(tt(), "consult", "enc1@m1");
    expect(out).toMatchObject({ status: "skipped", reason: "no_role_layer", evidence: { n_integrity_skipped: 1 } });
    expect(H.windowReads).toBe(0);
  });
});

describe("talk_time window unit", () => {
  it("is skipped role_layer_consult_only and reads no turns", async () => {
    const out = await evaluateUnit(tt(), "window", "w1");
    expect(out).toMatchObject({ status: "skipped", reason: "role_layer_consult_only" });
    expect(H.windowReads).toBe(0);
  });
});
