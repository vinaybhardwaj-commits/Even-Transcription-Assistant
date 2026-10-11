/** Patient-leave fusion. endConsult is the note. url_clear is not an end. Uncalibrated Jev does not place one. */
import { describe, expect, it } from "vitest";
import type { Anchor } from "@/lib/encounter-clock/anchors";
import { fuseLeave, NEXT_START_BACKOFF_MS, PRE_START_MS } from "@/lib/encounter-clock/fusion-leave";
import type { RowFact } from "@/lib/encounter-clock/fusion-timeline";
import type { RowMeta } from "@/lib/encounter-clock/timeline";
import { emptyCalibration, fitCalibration, type Calibration } from "@/lib/encounter-clock/timeline-calibration";

const T0 = 1_790_000_000_000;
const anchor = (o: Partial<Anchor> = {}): Anchor => ({
  consult_key: "c1", room_id: "room_fake1", start_ms: T0 + 30_000, close_kind: "open", end_clicked: false, end_click_ms: null,
  end_weak_ms: null, end_weak_kind: null, next_start_ms: null, doctor_uid_warehouse: "doc_uid_1", doctor_uid_ext: null,
  doctor_source: "warehouse", quality: "ok" as never, weak_start: false, ...o,
});

function grid(facts: Array<Partial<RowFact> & { t: string }>): { meta: RowMeta[]; rows: RowFact[] } {
  const meta: RowMeta[] = [];
  const rows: RowFact[] = [];
  facts.forEach((f, i) => {
    const start_ms = T0 + i * 30_000;
    meta.push({ t: f.t, start_ms, end_ms: start_ms + 30_000, probe_first: null, probe_last: null });
    rows.push({
      start_ms, end_ms: start_ms + 30_000, sound: "active", speech_s: 10, doc_s: 0, other_s: 0, voices: [], voice_s: {}, ...f,
    });
  });
  return { meta, rows };
}

const acting = (): Calibration => fitCalibration(Array.from({ length: 8 }, (_, i) => ({ raw: (i + 1) / 10, correct: true })));

const base = () => grid([
  { t: "t+00:00", other_s: 20, doc_s: 10, voices: ["DOC", "B"] },
  { t: "t+00:30", other_s: 15, doc_s: 5, voices: ["DOC", "B"] },
  { t: "t+01:00", other_s: 0, doc_s: 20, voices: ["DOC"], sound: "active" },
]);

describe("fuseLeave", () => {
  it("ends the consult when the other voice stops and the doctor is still there; the note click is stored and does not move the end", () => {
    const { meta, rows } = base();
    const click = rows[2]!.end_ms + 60_000;
    const f = fuseLeave({
      anchor: anchor({ end_click_ms: click, end_clicked: true, close_kind: "clicked_end" }),
      meta, rows, other_speech: [{ start_ms: rows[0]!.start_ms, end_ms: rows[1]!.end_ms - 5_000 }],
      jev: null, calibration: emptyCalibration(),
    });
    expect(f.closed_by).toBe("patient_left");
    expect(f.end_ms).toBe(rows[1]!.end_ms - 5_000);
    expect(f.end_ms).not.toBe(click);
    expect(f.encounter_end_ms).toBe(click);
    expect(f.reason_codes).toContain("note_submitted");
    expect(f.reason_codes).toContain("patient_left");
    expect(f.jev_used).toBe(false);
    expect(f.start_ms).toBe(anchor().start_ms - PRE_START_MS);
  });

  it("url_clear is a weak close, not the consult end and not the encounter end", () => {
    const { meta, rows } = base();
    const f = fuseLeave({
      anchor: anchor({ end_weak_kind: "url_clear", end_weak_ms: rows[1]!.end_ms, close_kind: "url_clear" }),
      meta, rows, other_speech: [], jev: null, calibration: emptyCalibration(),
    });
    expect(f.reason_codes).toContain("weak_url_clear");
    expect(f.encounter_end_ms).toBeNull();
    expect(f.closed_by).toBe("patient_left");
    expect(f.end_ms).toBe(rows[1]!.end_ms);
  });

  it("the next Start clamps an end that would run past it", () => {
    const { meta, rows } = base();
    const next = rows[1]!.start_ms + 20_000;
    const f = fuseLeave({
      anchor: anchor({ next_start_ms: next }),
      meta, rows, other_speech: [{ start_ms: rows[0]!.start_ms, end_ms: rows[1]!.end_ms }],
      jev: null, calibration: emptyCalibration(),
    });
    expect(f.end_ms).toBe(next - NEXT_START_BACKOFF_MS);
    expect(f.reason_codes).toContain("next_start_bound");
    expect(f.closed_by).toBe("patient_left");
  });

  it("with no other voice the fallback end is the next Start, not a fake patient-leave", () => {
    const { meta, rows } = grid([{ t: "t+00:00", doc_s: 10, other_s: 0, voices: ["DOC"] }]);
    const next = T0 + 10 * 60_000;
    const f = fuseLeave({
      anchor: anchor({ next_start_ms: next }),
      meta, rows, other_speech: [], jev: null, calibration: emptyCalibration(),
    });
    expect(f.closed_by).toBe("next_start");
    expect(f.reason_codes).toContain("no_patient_voice");
    expect(f.end_ms).toBe(next - NEXT_START_BACKOFF_MS);
  });

  it("an uncalibrated Jev end, including raw 0.95, does not place the consult", () => {
    const { meta, rows } = base();
    const f = fuseLeave({
      anchor: anchor(), meta, rows, other_speech: [{ start_ms: rows[0]!.start_ms, end_ms: rows[0]!.end_ms }],
      jev: { end_row: "t+00:00", end_signal: "patient_left", end_conf: 0.95, late_start_p: 0.95, kind: "consultation", kind_conf: 0.95 },
      calibration: emptyCalibration(),
    });
    expect(f.jev_used).toBe(false);
    expect(f.confidence).toBeNull();
    expect(f.reason_codes).toContain("uncalibrated_jev");
    expect(f.closed_by).toBe("patient_left");
    expect(f.end_ms).toBe(rows[1]!.end_ms);
  });

  it("a calibrated end is vetoed when other voices continue into the next row", () => {
    const { meta, rows } = grid([
      { t: "t+00:00", other_s: 25, doc_s: 5 },
      { t: "t+00:30", other_s: 25, doc_s: 0 },
      { t: "t+01:00", other_s: 0, doc_s: 10, sound: "quiet" },
      { t: "t+01:30", other_s: 0, doc_s: 0, sound: "quiet" },
      { t: "t+02:00", other_s: 0, doc_s: 0, sound: "quiet" },
    ]);
    const f = fuseLeave({
      anchor: anchor(), meta, rows,
      other_speech: [{ start_ms: rows[0]!.start_ms, end_ms: rows[1]!.end_ms }],
      jev: { end_row: "t+00:00", end_signal: null, end_conf: 0.4, late_start_p: null, kind: null, kind_conf: null },
      calibration: acting(),
    });
    expect(f.reason_codes).toContain("acoustic_veto");
    expect(f.jev_used).toBe(false);
    expect(f.end_ms).toBe(rows[1]!.end_ms);
  });

  it("a calibrated end row snaps to the last other-voice instant in that row", () => {
    const { meta, rows } = base();
    const leaveAt = rows[0]!.start_ms + 12_000;
    const f = fuseLeave({
      anchor: anchor(), meta, rows,
      other_speech: [{ start_ms: rows[0]!.start_ms, end_ms: leaveAt }],
      jev: { end_row: "t+00:00", end_signal: "patient_left", end_conf: 0.4, late_start_p: null, kind: "consultation", kind_conf: 0.5 },
      calibration: acting(),
    });
    expect(f.jev_used).toBe(true);
    expect(f.end_ms).toBe(leaveAt);
    expect(f.closed_by).toBe("patient_left");
    expect(f.confidence).not.toBeNull();
    expect(f.reason_codes).toContain("jev_end_row");
  });
});
