import { describe, it, expect } from "vitest";
import { parseArtefact } from "@/lib/spine/artefact";
import { resolveOutcome, RELEASE_BACKOFF_MS } from "@/lib/spine/retry";

const base = { engine: "nemotron", version: "v1", cfg8: "0a1b2c3d", store: "box", status: "ok", sha256: "a".repeat(64) };
const ok = (k: string) => parseArtefact({ ...base, object_key: k }) !== null;

describe("R4 F6b: object_key is a CLOSED shape", () => {
  it.each([
    "consult.flac", "tracks/diar.nemotron__f667ed73__0a1b2c3d.json", "tracks/diar.nemotron__12345678__87654321.json", "tracks/diar.nemotron__v1__0a1b2c3d.json",
    "tracks/acoustics.room_profile_acoustics__v1__0a1b2c3d.json", "tracks/stt.koyal__box-t4-koyal-1__0a1b2c3d.json",
  ])("accepts %s", (k) => expect(ok(k)).toBe(true));
  it.each([
    "tracks/priya_sharma.json", "ravi/kumar/consult.flac", "opd4/consult.flac", "tracks/19-10-2026/consult.flac", "tracks/2026_10_20/consult.flac", "tracks/9876543.json", "tracks/",
    "tracks/diar.nemotron__f667ed73__0a1b2c3d.json/", "tracks/stt.sarvam__v1__0a1b2c3d.json", "tracks/stt.medasr__box-t4-medasr-1__0a1b2c3d.json", "tracks/stt.koyal__v1__0a1b2c3d.json",
    "tracks/diar.nemotron__9876543210__0a1b2c3d.json", "tracks/diar.nemotron__priya-sharma__0a1b2c3d.json", "tracks/diar.nemotron__123456789012__0a1b2c3d.json",
    "tracks/acoustics.room_profile_acoustics__f667ed73__0a1b2c3d.json", "tracks/stt.koyal__box-t4-koyal-1234__0a1b2c3d.json", "tracks/diar.nemotron__v1__0A1B2C3D.json",
    "/consult.flac", "uid_test_01_consult.flac", "x/tracks/diar.nemotron__v1__0a1b2c3d.json", "tracks/constructor.json", "tracks/__proto__.json", "consult.flac/",
  ])("refuses %s", (k) => expect(ok(k)).toBe(false));
});

describe("R4: a release backs off", () => {
  const now = new Date("2026-10-20T06:00:00Z");
  it("release: queued 60 s ahead, attempt given back", () => {
    expect(RELEASE_BACKOFF_MS).toBe(60_000);
    expect(resolveOutcome("release", 1, now, 0.5)).toMatchObject({ status: "queued", nextAttemptAt: new Date(now.getTime() + 60_000), attemptsDelta: -1, errorClass: null });
  });
});
