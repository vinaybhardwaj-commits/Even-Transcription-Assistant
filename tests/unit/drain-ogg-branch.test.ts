/**
 * Build 3.1 §B — the drain hands Gemini ogg and everything else webm.
 *
 * The two properties that would be expensive to get wrong:
 *   1. A window routed to Sarvam must do EXACTLY what it did yesterday — one join, webm bytes,
 *      webm receipt. The ogg path is an extra join for one engine, not a change to the clip
 *      Whisper segments and every other engine reads.
 *   2. The receipt must fingerprint the bytes the engine was ACTUALLY handed. A Gemini run whose
 *      `audio_sha256` described the webm clip would be a receipt for audio that engine never saw
 *      — precisely the auditability the whole evidence spine exists to provide.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { audioReceipt } from "@/lib/stt/receipt";
import {
  GEMINI_ADAPTER_KEY,
  GEMINI_PREFERRED_JOIN_FORMAT,
  GEMINI_PREFERRED_CONTENT_TYPE,
} from "@/lib/stt/adapters/gemini";

const codeOf = (f: string): string =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const drain = codeOf("lib/stt/room-drain.ts");

describe("the branch is on the ADAPTER, not on a string typed into the drain", () => {
  it("the drain compares adapter.key to the constant the adapter exports", () => {
    expect(drain).toContain("adapter.key === GEMINI_ADAPTER_KEY");
    expect(GEMINI_ADAPTER_KEY).toBe("gemini");
  });

  it('the drain contains no bare "gemini" literal', () => {
    // C5's rule: the engine id is read from the adapter that was called, never re-derived from a
    // string. A literal here would be a second place to get the key wrong.
    expect(drain).not.toMatch(/["'`]gemini["'`]/);
  });

  it("the container and content type come from the adapter too", () => {
    expect(GEMINI_PREFERRED_JOIN_FORMAT).toBe("ogg");
    expect(GEMINI_PREFERRED_CONTENT_TYPE).toBe("audio/ogg");
    expect(drain).toContain("GEMINI_PREFERRED_JOIN_FORMAT");
    expect(drain).toContain("audioContentType = GEMINI_PREFERRED_CONTENT_TYPE");
  });
});

describe("every other engine is untouched", () => {
  it("the defaults are the webm clip that was already joined and downloaded", () => {
    expect(drain).toContain("let audioBytes: Uint8Array = bytes;");
    expect(drain).toContain("let audioKey: string = join.key;");
    expect(drain).toContain('let audioContentType = "audio/webm";');
  });

  it("the second join happens ONLY inside the Gemini branch", () => {
    const branchStart = drain.indexOf("adapter.key === GEMINI_ADAPTER_KEY");
    // C1b fix-up 3 routed every adapter call through guardedTranscribe, so the engine is no
    // longer invoked by a literal `adapter.transcribe(...)` here. The subject is unchanged: the
    // ogg join must happen BEFORE the engine is handed anything.
    const transcribeAt = drain.indexOf("await guardedTranscribe({");
    const oggJoinAt = drain.indexOf("callJoinService(oggReq)");
    expect(oggJoinAt).toBeGreaterThan(branchStart);
    expect(oggJoinAt).toBeLessThan(transcribeAt);
  });

  it("Whisper still reads the webm clip — the segmenter is not moved onto ogg", () => {
    // The full-window Whisper call must still use `bytes`, the original webm download.
    expect(drain).toContain("const full = await transcribeWithWhisper(Buffer.from(bytes)");
  });

  it("the engine is handed the resolved buffer and content type, not a hardcoded webm", () => {
    // Still the resolved buffer and the resolved type — now passed through the chokepoint, which
    // is the only thing that calls an adapter.
    expect(drain).toContain("audio: Buffer.from(audioBytes)");
    expect(drain).toContain("contentType: audioContentType");
    expect(drain).not.toContain('contentType: "audio/webm",\n      longForm: true');
  });
});

describe("the receipt describes the bytes actually sent", () => {
  it("the ROUTED RUN fingerprints the resolved buffer and key, not the webm download", () => {
    // Slice C1 added a SECOND receipt further down, for the shadow control run, and that one
    // legitimately fingerprints `join.key`/`bytes` — whisper really was handed the webm. A
    // file-wide "never audioReceipt(join.key, bytes)" can no longer tell the two apart, so the
    // assertion is scoped to its actual subject: the receipt that feeds the ROUTED engine's run.
    // It still bites — swapping audioKey/audioBytes back to join.key/bytes here fails it.
    // (`codeOf` strips comments, so the region is anchored on CODE at both ends.)
    // C1b moved this into the engine PHASE. The region is the phase itself, bounded by the two
    // function declarations either side, which is a tighter subject than before: the shadow run's
    // own receipt now lives in an earlier phase and is excluded by construction.
    const region = drain.slice(
      drain.indexOf("export async function roomWindowEngine"),
      drain.indexOf("export async function roomWindowPoll"),
    );
    expect(region.length, "the region must exist, or this test is asserting on an empty string").toBeGreaterThan(200);
    expect(region).toContain("audioReceipt(audioKey, audioBytes)");
    expect(region, "the routed run must not fingerprint the clip it may not have been sent").not.toContain("audioReceipt(join.key, bytes)");
  });

  it("a different container yields a different hash — so the receipt distinguishes them", () => {
    const webm = Buffer.from("webm-container-bytes");
    const ogg = Buffer.from("ogg-container-bytes");
    const a = audioReceipt("clips/x/w.webm", webm);
    const b = audioReceipt("clips/x/w.ogg", ogg);
    expect(a.audio_sha256).not.toBe(b.audio_sha256);
    expect(b.audio_sha256).toBe(createHash("sha256").update(ogg).digest("hex"));
    expect(b.audio_r2_key).toMatch(/\.ogg$/);
    expect(b.audio_byte_end).toBe(ogg.length);
  });
});

describe("the join being unavailable is a loud, named refusal BEFORE any spend", () => {
  it("ogg_join_unavailable is a real DrainStep and the drain returns it", () => {
    expect(drain).toContain('"ogg_join_unavailable"');
    expect(drain).toContain('recordFailure(windowId, "ogg_join_unavailable"');
  });

  it("both failure modes are covered: the join refuses, or the clip is not readable", () => {
    const branch = drain.slice(drain.indexOf("adapter.key === GEMINI_ADAPTER_KEY"), drain.indexOf("const asr = await adapter.transcribe"));
    expect(branch).toContain("if (!oggJoin.ok)");
    expect(branch).toContain("if (!oggBytes)");
    expect((branch.match(/ogg_join_unavailable/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("the refusal returns BEFORE adapter.transcribe — a pre-deploy box costs nothing", () => {
    const branch = drain.slice(drain.indexOf("adapter.key === GEMINI_ADAPTER_KEY"), drain.indexOf("const asr = await adapter.transcribe"));
    // Every path out of the branch that is not success is a `return`.
    expect(branch).toContain('return { ...out, step: "ogg_join_unavailable"');
    expect(branch).not.toContain("adapter.transcribe");
  });

  it("a pre-3.1 box fails HERE rather than at the engine — the whole point of the guard", () => {
    // A box that ignores `format` returns a webm clip under a .ogg key; the adapter's own MIME
    // guard would then be the thing that caught it, one paid call later. This branch is what
    // makes the failure free. (The adapter guard stays as defence in depth for other callers.)
    const adapterSrc = codeOf("lib/stt/adapters/gemini.ts");
    expect(adapterSrc).toContain("unsupported_audio_mime");
  });
});

describe("the adapter's own MIME guard survives for callers that are not the drain", () => {
  it("it still refuses webm — the fanout would send webm if it were ever enabled", () => {
    const adapterSrc = codeOf("lib/stt/adapters/gemini.ts");
    expect(adapterSrc).toContain("isMimeAllowed(opts.contentType, cfg.allowedMime)");
    expect(adapterSrc).toContain("unsupported_audio_mime:");
  });

  it("audio/ogg is on the allowlist, so the drain's ogg path passes it", async () => {
    const { GEMINI_AUDIO_MIME_ALLOWLIST } = await import("@/lib/stt/adapters/gemini");
    expect(GEMINI_AUDIO_MIME_ALLOWLIST).toContain("audio/ogg");
    expect(GEMINI_AUDIO_MIME_ALLOWLIST).not.toContain("audio/webm");
  });
});
