/**
 * tests/unit/jev-role.test.ts — Slice J3 (ETA-JEV-ARM-D §6.4). compositeRole (pure) and the
 * jev_role kind against a fake db + the mock Jev client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { compositeRole } from "@/lib/jev/role-composite";

describe("J3 — compositeRole: acoustic always outranks text", () => {
  it("a voiceprint match wins outright, even when text disagrees", () => {
    const r = compositeRole({ role: "patient", role_confidence: 0.9 }, { clinician_id: "clin_1", match_confidence: 0.8 });
    expect(r).toMatchObject({ role: "clinician", clinician_id: "clin_1", agree: false });
  });
  it("records agreement when text also says clinician", () => {
    const r = compositeRole({ role: "clinician", role_confidence: 0.9 }, { clinician_id: "clin_1", match_confidence: 0.8 });
    expect(r).toMatchObject({ role: "clinician", clinician_id: "clin_1", agree: true });
  });
  it("text never assigns a clinician_id, even when confident", () => {
    const r = compositeRole({ role: "clinician", role_confidence: 0.95 }, { clinician_id: null, match_confidence: null });
    expect(r).toMatchObject({ role: "clinician", clinician_id: null });
  });
  it("below the confidence floor, the speaker is left null with reason low_confidence", () => {
    const r = compositeRole({ role: "attendant", role_confidence: 0.3 }, { clinician_id: null, match_confidence: null });
    expect(r).toEqual({ role: null, clinician_id: null, reason: "low_confidence" });
  });
  it("at or above the floor, text stands alone", () => {
    const r = compositeRole({ role: "nurse_or_staff", role_confidence: 0.7 }, { clinician_id: null, match_confidence: null });
    expect(r).toMatchObject({ role: "nurse_or_staff", clinician_id: null });
  });
});

// ── the kind, against a fake db + the mock jev client ──────────────────────────────────────────
type DiarWindow = { window_id: string };
type TurnRow = { window_id: string; speaker_idx: number; text: string | null; clinician_id: string | null; match_confidence: number | null };
type RoleRow = Record<string, unknown>;

const DB = vi.hoisted(() => ({
  diarWindows: [] as DiarWindow[],
  turns: {} as Record<string, TurnRow[]>,
  existing: [] as Array<{ window_id: string; speaker_idx: number }>,
  written: {} as Record<string, RoleRow>,
  writes: 0,
}));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join(" ").replace(/\s+/g, " ");
    if (q.includes("FROM room_diarize_window WHERE room_day_id")) return DB.diarWindows;
    if (q.includes("FROM jev_role_signal WHERE room_day_id")) return DB.existing;
    if (q.includes("FROM room_turn_speaker t")) {
      const windowId = v[0] as string;
      return DB.turns[windowId] ?? [];
    }
    if (q.includes("INSERT INTO jev_role_signal")) {
      const [id, window_id, room_day_id, speaker_idx, cluster_id, role, role_probs, role_confidence, turn_count, char_count, model, prompt_version, input_tokens, batch_id] = v as unknown[];
      DB.written[`${window_id}:${speaker_idx}`] = { id, window_id, room_day_id, speaker_idx, cluster_id, role, role_probs, role_confidence, turn_count, char_count, model, prompt_version, input_tokens, batch_id };
      DB.writes += 1;
      return [];
    }
    return [];
  },
}));

import { jevRoleKind, JEV_ROLE_KIND } from "@/lib/jobs/kinds/jev-role";
import { setMockJevAnswers, clearMockJevAnswers } from "@/lib/jev/mock";
import { roleQid } from "@/lib/jev/prompts/role-v1";
import type { JobRow } from "@/lib/jobs/types";

async function drive(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = jevRoleKind.parseArgs(args);
  const out = await jevRoleKind.run({ job: {} as JobRow, step: jevRoleKind.first, args: parsed, progress: {} });
  if (out.kind !== "done") throw new Error(`expected done, got ${out.kind}`);
  return out.result;
}

beforeEach(() => {
  DB.diarWindows = [];
  DB.turns = {};
  DB.existing = [];
  DB.written = {};
  DB.writes = 0;
  clearMockJevAnswers();
  process.env.ETA_JEV_MOCK = "1";
  delete process.env.ETA_JEV_ENABLED;
});

describe("J3 — jev_role kind registration", () => {
  it("is named jev_role and scoped invoke", () => {
    expect(jevRoleKind.name).toBe(JEV_ROLE_KIND);
    expect(JEV_ROLE_KIND).toBe("jev_role");
    expect(jevRoleKind.scope).toBe("invoke");
  });
});

describe("J3 — grouping and the char floor", () => {
  it("groups turns by speaker_idx, drops a speaker under 40 chars, persists one row per speaker", async () => {
    DB.diarWindows = [{ window_id: "win1" }];
    DB.turns.win1 = [
      { window_id: "win1", speaker_idx: 0, text: "since when is this cough about five days and any fever at night", clinician_id: "clin_9", match_confidence: 0.85 },
      { window_id: "win1", speaker_idx: 1, text: "ok", clinician_id: null, match_confidence: null }, // under 40 chars — dropped
    ];
    setMockJevAnswers({ [roleQid("S0")]: { type: "choice", choice: "clinician", probabilities: { clinician: 0.9 }, confidence: 0.9 } });
    const result = await drive({ room_day_id: "rd1" });
    expect(result).toMatchObject({ windows_processed: 1, speakers_written: 1 });
    expect(DB.writes).toBe(1);
    expect(DB.written["win1:0"]).toMatchObject({ role: "clinician", window_id: "win1", speaker_idx: 0 });
    expect(DB.written["win1:1"]).toBeUndefined();
  });
});

describe("J3 — composite precedence inside the kind: acoustic wins over the text answer", () => {
  it("a clinician_id from room_turn_speaker overrides a non-clinician text answer", async () => {
    DB.diarWindows = [{ window_id: "win1" }];
    DB.turns.win1 = [{ window_id: "win1", speaker_idx: 0, text: "the doctor asked me to breathe in and checked my chest today", clinician_id: "clin_5", match_confidence: 0.9 }];
    setMockJevAnswers({ [roleQid("S0")]: { type: "choice", choice: "patient", probabilities: { patient: 0.8 }, confidence: 0.8 } });
    await drive({ room_day_id: "rd1" });
    expect(DB.written["win1:0"]).toMatchObject({ role: "clinician" });
  });
});

describe("J3 — force re-runs a speaker already signalled", () => {
  it("skips without force, re-asks with force", async () => {
    DB.diarWindows = [{ window_id: "win1" }];
    DB.turns.win1 = [{ window_id: "win1", speaker_idx: 0, text: "handling the vitals and the tokens for the morning queue today", clinician_id: null, match_confidence: null }];
    DB.existing = [{ window_id: "win1", speaker_idx: 0 }];
    setMockJevAnswers({ [roleQid("S0")]: { type: "choice", choice: "nurse_or_staff", probabilities: { nurse_or_staff: 0.8 }, confidence: 0.8 } });

    const r1 = await drive({ room_day_id: "rd1" });
    expect(r1).toMatchObject({ speakers_written: 0 });
    expect(DB.writes).toBe(0);

    const r2 = await drive({ room_day_id: "rd1", force: true });
    expect(r2).toMatchObject({ speakers_written: 1 });
    expect(DB.writes).toBe(1);
  });
});
