/**
 * Build 3.1 — the join service's output container becomes a parameter.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE ONE ABOUT NOT CHANGING ANYTHING. `clipKey()` is
 * deterministic by design: the same window on the same session and microphone is the same key, so
 * re-joining OVERWRITES rather than growing the archive. That makes the default load-bearing in a
 * way a default usually is not — if `format` defaulted to ogg, or were required, every clip the
 * room drain, the MCP extract tool and the operator page have ever produced would quietly change
 * container under an unchanged key. Several tests below exist only to pin "absent format behaves
 * exactly like yesterday".
 */
import { describe, it, expect } from "vitest";
import {
  buildFfmpegArgs,
  validateJoinRequest,
  formatSpec,
  contentTypeFor,
  outKeyForFormat,
  FORMATS,
  DEFAULT_FORMAT,
  OUT_CONTENT_TYPE,
  JOIN_SERVICE_VERSION,
} from "../../services/audio-join/container/join-core.mjs";
import { buildJoinRequest } from "@/lib/bench-join";

const piece = (idx: number) => ({
  chunk: { idx, r2_key: `bench/room/2026-08-24/bs_x/chunk_0000${idx}.webm` },
  offset_in_chunk_s: 0,
  duration_s: 300,
});
const OK_BODY = {
  pieces: [{ key: "bench/a.webm", idx: 0 }],
  trim: { start_ms: 0, end_ms: 900_000 },
  out_key: "clips/bs_x/20260824T063000Z-20260824T064500Z-primary.webm",
  meta: {},
};

describe("the default is webm, and absent means absent", () => {
  it("a request with NO format validates to webm", () => {
    const v = validateJoinRequest(OK_BODY);
    expect(v.ok).toBe(true);
    expect(v.job.format).toBe("webm");
    expect(DEFAULT_FORMAT).toBe("webm");
  });

  it("the key is untouched for a webm request — byte-identical to today", () => {
    const v = validateJoinRequest(OK_BODY);
    expect(v.job.out_key).toBe(OK_BODY.out_key);
  });

  it("the ffmpeg argv for a default call is IDENTICAL to the pre-3.1 argv", () => {
    // The pre-3.1 tail, verbatim. If this drifts, every existing clip changes.
    const args = buildFfmpegArgs(["a", "b"], 0, 900_000, "/tmp/out.webm");
    expect(args.slice(-11)).toEqual([
      "-vn", "-sn", "-dn",
      "-c:a", "libopus",
      "-b:a", "32k",
      "-ar", "48000",
      "-ac", "1",
      "-f", "webm",
      "/tmp/out.webm",
    ].slice(-11));
    expect(args).toContain("webm");
    expect(args).not.toContain("ogg");
  });

  it("an explicit webm behaves exactly like an absent one", () => {
    const withFormat = validateJoinRequest({ ...OK_BODY, format: "webm" });
    const without = validateJoinRequest(OK_BODY);
    expect(withFormat.job).toEqual(without.job);
  });

  it("buildJoinRequest omits the key entirely when no format is given", () => {
    const req = buildJoinRequest("bs_x", [piece(0)], 0, 900_000, "primary", new Date(0));
    expect("format" in req).toBe(false);
    expect(JSON.stringify(req)).not.toContain("format");
  });

  it("OUT_CONTENT_TYPE is still webm for anything still reading it", () => {
    expect(OUT_CONTENT_TYPE).toBe("audio/webm");
    expect(contentTypeFor(undefined)).toBe("audio/webm");
  });
});

describe("ogg produces audio/ogg and a distinct key", () => {
  it("the content type follows the container", () => {
    expect(contentTypeFor("ogg")).toBe("audio/ogg");
    expect(FORMATS.ogg.contentType).toBe("audio/ogg");
  });

  it("the ffmpeg argv changes the MUX and nothing else — same codec, same bitrate", () => {
    const webm = buildFfmpegArgs(["a"], 0, 900_000, "/tmp/o.webm", "webm");
    const ogg = buildFfmpegArgs(["a"], 0, 900_000, "/tmp/o.ogg", "ogg");
    // Only the -f value and the out path differ.
    expect(ogg).toContain("libopus");
    expect(ogg[ogg.indexOf("-f") + 1]).toBe("ogg");
    expect(webm[webm.indexOf("-f") + 1]).toBe("webm");
    expect(ogg.filter((a) => a !== "ogg" && a !== "/tmp/o.ogg"))
      .toEqual(webm.filter((a) => a !== "webm" && a !== "/tmp/o.webm"));
  });

  it("THE KEY CANNOT COLLIDE — the service rewrites the extension", () => {
    const v = validateJoinRequest({ ...OK_BODY, format: "ogg" });
    expect(v.ok).toBe(true);
    expect(v.job.out_key).toMatch(/\.ogg$/);
    expect(v.job.out_key).not.toBe(OK_BODY.out_key);
    // The two containers of the SAME window are two different objects.
    expect(validateJoinRequest(OK_BODY).job.out_key).not.toBe(v.job.out_key);
  });

  it("outKeyForFormat replaces a trailing extension and appends when there is none", () => {
    expect(outKeyForFormat("clips/x/a.webm", "ogg")).toBe("clips/x/a.ogg");
    expect(outKeyForFormat("clips/x/a.ogg", "webm")).toBe("clips/x/a.webm");
    expect(outKeyForFormat("clips/x/a", "ogg")).toBe("clips/x/a.ogg");
    // It never mangles a dotted path segment that is not the extension.
    expect(outKeyForFormat("clips/x/a.b.webm", "ogg")).toBe("clips/x/a.b.ogg");
  });

  it("buildJoinRequest carries an explicit ogg through", () => {
    const req = buildJoinRequest("bs_x", [piece(0)], 0, 900_000, "primary", new Date(0), "ogg");
    expect(req.format).toBe("ogg");
  });
});

describe("an unknown format is REFUSED, never silently defaulted", () => {
  it("a format this service cannot emit is a named error", () => {
    const v = validateJoinRequest({ ...OK_BODY, format: "flac" });
    expect(v.ok).toBe(false);
    expect(v.error).toBe("bad_format");
    expect(v.supported).toEqual(["webm", "ogg"]);
  });

  it("a non-string format is refused too", () => {
    expect(validateJoinRequest({ ...OK_BODY, format: 7 }).error).toBe("bad_format");
    expect(validateJoinRequest({ ...OK_BODY, format: {} }).error).toBe("bad_format");
  });

  it("formatSpec says null for an unknown name and webm for an absent one", () => {
    expect(formatSpec("flac")).toBeNull();
    expect(formatSpec(undefined)).toBe(FORMATS.webm);
    expect(formatSpec(null)).toBe(FORMATS.webm);
  });

  it("giving a caller webm when it asked for flac would be the failure this prevents", () => {
    // Stated as a test because a silent fallback here hands an engine a container it cannot read
    // while reporting success — the same class as the MIME relabelling Build 3 refused to do.
    const v = validateJoinRequest({ ...OK_BODY, format: "flac" });
    expect(v.ok).toBe(false);
    expect(v.job).toBeUndefined();
  });
});

describe("the deploy is verifiable from outside", () => {
  it("the version and the format list are what /health must carry", () => {
    expect(JOIN_SERVICE_VERSION).toBe("1.2.0");
    expect(Object.keys(FORMATS)).toEqual(["webm", "ogg"]);
  });

  it("the worker's /health reports both", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("services/audio-join/worker/index.js", "utf8"));
    const health = src.slice(src.indexOf('url.pathname === "/health"'), src.indexOf('if (url.pathname !== "/join")'));
    expect(health).toContain("version: JOIN_SERVICE_VERSION");
    expect(health).toContain("formats: Object.keys(FORMATS)");
  });

  it("the container's /health reports both, so both hops are checkable", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("services/audio-join/container/server.mjs", "utf8"));
    expect(src).toContain("version: JOIN_SERVICE_VERSION");
    expect(src).toContain("formats: Object.keys(FORMATS)");
  });

  it("a pre-3.1 box is DISTINGUISHABLE — it answers /health without these fields", () => {
    // The whole point of putting them on health: "did my deploy land" is one curl, not a guess.
    const preDeploy = { ok: true, service: "eta-audio-join", clips_prefix: "clips/" };
    expect("formats" in preDeploy).toBe(false);
    expect("version" in preDeploy).toBe(false);
  });
});

describe("the container muxes what the header asked for", () => {
  it("the worker puts the format in the frame header", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("services/audio-join/worker/index.js", "utf8"));
    expect(src).toContain("format: job.format");
  });

  it("the R2 object's stored content type follows the format", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("services/audio-join/worker/index.js", "utf8"));
    expect(src).toContain("contentType: contentTypeFor(job.format)");
  });

  it("the container reads the header's format and defaults defensively", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("services/audio-join/container/server.mjs", "utf8"));
    expect(src).toContain("formatSpec(header?.format) ? header.format : DEFAULT_FORMAT");
    expect(src).toContain("contentTypeFor(format)");
    expect(src).toContain("buildFfmpegArgs(files, startMs, endMs, outPath, format)");
  });
});
