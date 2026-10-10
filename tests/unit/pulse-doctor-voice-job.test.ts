/**
 * The pulse_doctor_voice job (lib/jobs/kinds/pulse-doctor-voice.ts) with its SQL, R2, the Mini and the voiceprint
 * loader mocked. Embeddings are hand-built axis vectors (see voice-room-print-recurring.test.ts), sent as float32 LE
 * base64 built here, not by the code under test. Ids are fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClinician } from "../support/fake-identity";

const H = vi.hoisted(() => ({
  windows: [] as Array<{ row_id: number; window_id: string; day: string; turns_json: unknown; clip_r2_key: string | null }>,
  blind: 0,
  embed: vi.fn(),
  write: vi.fn(),
  run: vi.fn(),
  bytes: new Uint8Array([1]) as Uint8Array | null,
  centroids: [] as Array<{ clinician_id: string; full_name: string; centroid_base64: string }>,
}));
vi.mock("@/lib/room-access/pulse-doctor-voice", () => ({
  doctorWindows: async () => ({ windows: H.windows, n_blind_excluded: H.blind }),
  writeDoctorVoice: H.write,
  recordDoctorVoiceRun: H.run,
}));
vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => H.bytes }));
vi.mock("@/lib/diarize-embed", () => ({ embedSpeakers: H.embed }));
vi.mock("@/lib/stt/diarize-window", () => ({ DIARIZE_BATCH_THRESHOLD: 0.65, loadClinicianCentroids: async () => H.centroids }));
vi.mock("@/lib/db", () => ({ sql: async () => [] }));

const K = await import("@/lib/jobs/kinds/pulse-doctor-voice");

const DIM = 16;
const b64 = (xs: number[]) => { const b = Buffer.alloc(xs.length * 4); xs.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b.toString("base64"); };
const axis = (k: number, w = 0) => { const v = new Array(DIM).fill(0); v[k] = 1; v[DIM - 1] = w; return v; };
/** Two Nemotron speakers: spk0 talks 40 s, spk1 20 s, so embedPlan ranks spk0 as idx 0 and spk1 as idx 1. */
const TURNS = [[0, 40_000, "spk0"], [40_000, 60_000, "spk1"]];
const win = (i: number, day: string) => ({ row_id: i + 1, window_id: `bw_fake_${i}`, day, turns_json: TURNS, clip_r2_key: `clips/bs_fake/${i}.webm` });
const ctx = (uid = "pulse_doc_fake1") => ({ job: {} as never, step: "build", args: K.pulseDoctorVoiceKind.parseArgs({ pulse_doctor_uid: uid }), progress: {} });

/** The Mini's answer for window i: rank 0 = the doctor (axis 0), rank 1 = a patient on a fresh axis. */
const mini = (i: number) => ({ ok: true, latencyMs: 1, speakers: [
  { idx: 0, embedding_base64: b64(axis(0, i % 2 ? 0.3 : -0.3)) },
  { idx: 1, embedding_base64: b64(axis(1 + i)) },
] });

beforeEach(() => {
  H.embed.mockReset(); H.write.mockReset(); H.run.mockReset();
  H.write.mockResolvedValue({ id: "pdv_fake", generation: 2, retired: 1 });
  H.bytes = new Uint8Array([1]); H.blind = 0; H.centroids = [];
  H.windows = Array.from({ length: 6 }, (_, i) => win(i, i % 2 ? "2026-10-03" : "2026-10-05"));
});

describe("parseArgs", () => {
  it("takes a Pulse uid and refuses anything else", () => {
    expect(K.pulseDoctorVoiceKind.parseArgs({ pulse_doctor_uid: "pulse_doc_fake1" })).toEqual({ pulse_doctor_uid: "pulse_doc_fake1" });
    for (const bad of [{}, { pulse_doctor_uid: "" }, { pulse_doctor_uid: "a b" }, { pulse_doctor_uid: 7 }, null]) expect(() => K.pulseDoctorVoiceKind.parseArgs(bad)).toThrow();
  });
  it("is a room-data kind with the per-unit guard and dedupes on the uid", async () => {
    expect(K.pulseDoctorVoiceKind.roomData).toBe(true);
    expect(await K.pulseDoctorVoiceKind.heldOut!({ pulse_doctor_uid: "x" })).toBeNull();
    expect(K.pulseDoctorVoiceKind.dedupeOn!({ pulse_doctor_uid: "pulse_doc_fake1" })).toEqual([["pulse_doctor_uid", "pulse_doc_fake1"]]);
  });
});

describe("the build", () => {
  it("builds from the recurring voice, writes it with counts and the nearest clinician, and calls the Mini once per window", async () => {
    const [near, far] = [1, 2].map((n) => makeFakeClinician(n));
    H.centroids = [{ clinician_id: far!.id, full_name: far!.full_name, centroid_base64: b64(axis(1)) }, { clinician_id: near!.id, full_name: near!.full_name, centroid_base64: b64(axis(0, 1)) }];
    H.blind = 3;
    H.embed.mockImplementation(async (_b: unknown, _req: unknown, _c: unknown, o: { label: string }) => mini(Number(o.label.split("_").pop())));
    const out = await K.pulseDoctorVoiceKind.run(ctx());
    expect(H.embed).toHaveBeenCalledTimes(6);
    // the request is embedPlan's: rank 0 is the longer speaker
    expect(H.embed.mock.calls[0]![1]).toEqual([{ idx: 0, start_s: 0, end_s: 40, total_speech_sec: 40 }, { idx: 1, start_s: 40, end_s: 60, total_speech_sec: 20 }]);
    expect(H.run).not.toHaveBeenCalled();
    const w = H.write.mock.calls[0]![0];
    expect(w).toMatchObject({ uid: "pulse_doc_fake1", n_windows: 6, n_days: 2, windows_offered: 6, windows_embedded: 6, support: 1, runner_up_windows: 0, n_blind_excluded: 3, embedding_model: "speechbrain/spkrec-ecapa-voxceleb", actor: "job:pulse_doctor_voice" });
    expect(w.embedding).toHaveLength(DIM);
    expect(w.embedding[0]).toBeCloseTo(1, 5);
    expect(w.nearest.clinician_id).toBe(near!.id);
    expect(w.nearest.score).toBeCloseTo(Math.SQRT1_2, 5);
    expect(w.source.members.every((m: { label: string }) => m.label === "spk0")).toBe(true);
    expect(w.id).toMatch(/^pdv_[0-9a-z]{12}$/);
    expect(out).toMatchObject({ kind: "done", result: { outcome: "built", voice_id: "pdv_fake", generation: 2 } });
  });

  it("refuses under 4 windows without calling the Mini", async () => {
    H.windows = H.windows.slice(0, 3);
    const out = await K.pulseDoctorVoiceKind.run(ctx());
    expect(H.embed).not.toHaveBeenCalled();
    expect(H.run.mock.calls[0]![0]).toMatchObject({ uid: "pulse_doc_fake1", outcome: "refused", reason: "too_few_windows", windows_offered: 3 });
    expect(out).toMatchObject({ result: { outcome: "refused", reason: "too_few_windows" } });
  });

  it("records a failed run when every embed call fails, and writes no print", async () => {
    H.embed.mockResolvedValue({ ok: false, error: "embed_failed", retryable: true });
    await K.pulseDoctorVoiceKind.run(ctx());
    expect(H.write).not.toHaveBeenCalled();
    expect(H.run.mock.calls[0]![0]).toMatchObject({ outcome: "failed", reason: "embed_failed", windows_offered: 6, windows_embedded: 0 });
  });

  it("records the finder's refusal with its counts (one day only)", async () => {
    H.windows = H.windows.map((w) => ({ ...w, day: "2026-10-03" }));
    H.embed.mockImplementation(async (_b: unknown, _r: unknown, _c: unknown, o: { label: string }) => mini(Number(o.label.split("_").pop())));
    await K.pulseDoctorVoiceKind.run(ctx());
    expect(H.write).not.toHaveBeenCalled();
    expect(H.run.mock.calls[0]![0]).toMatchObject({ outcome: "refused", reason: "too_few_days", n_windows: 6, n_days: 1, windows_embedded: 6 });
  });

  it("skips a window with no clip or bad turns, and still builds from the rest", async () => {
    H.windows = [...H.windows, { ...win(7, "2026-10-03"), clip_r2_key: null }, { ...win(8, "2026-10-05"), turns_json: "nope" }];
    H.embed.mockImplementation(async (_b: unknown, _r: unknown, _c: unknown, o: { label: string }) => mini(Number(o.label.split("_").pop())));
    await K.pulseDoctorVoiceKind.run(ctx());
    expect(H.embed).toHaveBeenCalledTimes(6);
    expect(H.write.mock.calls[0]![0]).toMatchObject({ windows_embedded: 6, n_windows: 6 });
  });

  it("starts no embed call after 60 s, and builds from what it has", async () => {
    H.windows = Array.from({ length: 8 }, (_, i) => win(i, i % 2 ? "2026-10-03" : "2026-10-05"));
    H.embed.mockImplementation(async (_b: unknown, _r: unknown, _c: unknown, o: { label: string }) => mini(Number(o.label.split("_").pop())));
    let t = 0;
    // each read of the clock advances 12 s: the loop checks before each window, so calls start at 12, 24, 36, 48, 60 s
    await K.runWithClock(ctx(), () => (t += 12_000) - 12_000);
    expect(H.embed).toHaveBeenCalledTimes(5);
    expect(H.write.mock.calls[0]![0]).toMatchObject({ windows_offered: 5, windows_embedded: 5, n_windows: 5 });
  });
});
