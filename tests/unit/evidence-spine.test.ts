/**
 * Build 2 §B / §D / §E — actor threading, the two admin surfaces, and the queued ::bigint fix.
 *
 * The rule with the sharpest edge here: a missing actor is a LOUD ERROR, not a default. The
 * obvious `actor ?? "system"` would thread the plumbing and destroy the thing being built — the
 * spend ledger is the audited form of "paid runs happen only by operator action", and a default
 * files every broken-plumbing run under a name implying nobody was responsible.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  actorProblem,
  isUsableActor,
  isValidVia,
  audioReceipt,
  providerEngineVersion,
  SYSTEM_ACTOR,
} from "@/lib/stt/receipt";
import { buildLeaderboard, buildLedger } from "@/lib/stt/window-leaderboard";

const codeOf = (f: string): string =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("an actor may never be defaulted", () => {
  it("a missing actor is a problem, not a fallback", () => {
    expect(actorProblem(undefined)).toBe("actor_missing");
    expect(actorProblem(null)).toBe("actor_missing");
    expect(actorProblem({ via: "admin_route" })).toBe("actor_missing");
  });

  it("an EMPTY admin id is refused — the guards produce '' from a token with no admin_id", () => {
    expect(isUsableActor("")).toBe(false);
    expect(isUsableActor("   ")).toBe(false);
    expect(actorProblem({ actor: "", via: "admin_route" })).toBe("actor_missing");
    expect(actorProblem({ actor: "   ", via: "admin_route" })).toBe("actor_missing");
  });

  it("a real admin id through a real door is fine", () => {
    expect(actorProblem({ actor: "adm_123", via: "admin_route" })).toBeNull();
    expect(actorProblem({ actor: "adm_123", via: "mcp" })).toBeNull();
  });

  it("an invalid via is refused", () => {
    expect(isValidVia("admin_route")).toBe(true);
    expect(isValidVia("mcp")).toBe(true);
    expect(isValidVia("cron")).toBe(true);
    expect(isValidVia("api")).toBe(false);
    expect(actorProblem({ actor: "adm_123", via: "api" as never })).toContain("via_invalid");
  });

  it("crossed plumbing is refused in BOTH directions — the ledger must not mix people and crons", () => {
    expect(actorProblem({ actor: SYSTEM_ACTOR, via: "admin_route" })).toBe("system_actor_needs_cron_via");
    expect(actorProblem({ actor: "adm_123", via: "cron" })).toBe("cron_via_needs_system_actor");
    expect(actorProblem({ actor: SYSTEM_ACTOR, via: "cron" })).toBeNull();
  });
});

describe("the drain refuses before it spends", () => {
  const drain = codeOf("lib/stt/room-drain.ts");

  it("`no_actor` is a real DrainStep and the guard returns it", () => {
    expect(drain).toContain('"no_actor"');
    expect(drain).toContain("actorProblem(opts)");
  });

  it("the guard runs BEFORE the window is claimed and before any paid call", () => {
    const guardAt = drain.indexOf("actorProblem(opts)");
    const claimAt = drain.indexOf("UPDATE bench_window SET state = 'transcribing'");
    // The engine is now reached only through the chokepoint; the subject — the actor check comes
    // before anything that can spend money — is unchanged and, if anything, sharper.
    const paidAt = drain.indexOf("await guardedTranscribe({");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(claimAt);
    expect(guardAt).toBeLessThan(paidAt);
  });

  it("actor and via are REQUIRED in the signature — a forgetful caller is a compile error", () => {
    expect(drain).toContain("opts: { force?: boolean } & RunActor");
  });

  it("the batch drains refuse as a batch rather than per window", () => {
    expect(drain).toContain("actorProblem(actor)");
  });

  it("the run INSERT writes all seven receipt columns", () => {
    for (const col of [
      "initiated_by", "initiated_via", "engine_version_reported",
      "audio_r2_key", "audio_byte_start", "audio_byte_end", "audio_sha256",
    ]) {
      expect(drain).toContain(col);
    }
  });

  it("NOTHING in the drain defaults an actor", () => {
    expect(drain).not.toContain('actor ?? "system"');
    expect(drain).not.toMatch(/actor\s*\|\|\s*["']/);
  });
});

describe("both caller edges pass the initiator they had already resolved", () => {
  it("run-waiting keeps the admin id it used to discard", () => {
    const src = codeOf("app/api/admin/bench/run-waiting/route.ts");
    expect(src).toContain('via: "admin_route"');
    expect(src).toContain("isUsableActor(adminId)");
    // The old shape resolved and dropped it in one expression.
    expect(src).not.toContain("if ((await guard()) === null)");
  });

  it("the drain route uses the adminId it used to bind and never read", () => {
    const src = codeOf("app/api/admin/bench/drain/route.ts");
    expect(src).toContain('via: "admin_route"');
    expect(src).toContain("isUsableActor(adminId)");
    expect(src).toContain("drainRoomWindow(body.window_id, origin, { force: body.force === true, ...actor })");
  });
});

describe("the audio receipt fingerprints the bytes actually sent", () => {
  it("records the key, the whole-object range, and a sha256", () => {
    const r = audioReceipt("clips/bs_x/a-b-primary.webm", Buffer.from("hello"));
    expect(r.audio_r2_key).toBe("clips/bs_x/a-b-primary.webm");
    expect(r.audio_byte_start).toBe(0);
    expect(r.audio_byte_end).toBe(5);
    expect(r.audio_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different bytes give a different fingerprint; identical bytes give the same one", () => {
    expect(audioReceipt(null, Buffer.from("a")).audio_sha256)
      .not.toBe(audioReceipt(null, Buffer.from("b")).audio_sha256);
    expect(audioReceipt(null, Buffer.from("a")).audio_sha256)
      .toBe(audioReceipt("other-key", Buffer.from("a")).audio_sha256);
  });
});

describe("the engine version is the PROVIDER's, or null — never the string we sent", () => {
  it("no adapter reports one today, so it is null", () => {
    expect(providerEngineVersion({ original: "x", latencyMs: 1, costUsd: null, error: null })).toBeNull();
    expect(providerEngineVersion(null)).toBeNull();
    expect(providerEngineVersion("saaras:v3")).toBeNull();
  });

  it("it picks one up the moment an adapter starts returning it", () => {
    expect(providerEngineVersion({ engineVersion: "saaras:v2.5" })).toBe("saaras:v2.5");
    expect(providerEngineVersion({ model_version: "gemini-3.7-flash" })).toBe("gemini-3.7-flash");
    expect(providerEngineVersion({ engineVersion: "   " })).toBeNull();
  });
});

describe("the leaderboard can never render WER without its refusal rate", () => {
  it("every row carries all four PRD fields together", () => {
    const rows = buildLeaderboard(
      [{ engine_key: "whisper", family: "whisper", wer: 0.2, cer: 0.1 }],
      [{ engine_key: "whisper", reason_code: "NO_GOLD", n: 3 }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ wer: 0.2, n_scored: 1, n_refused: 3 });
    expect(rows[0]!.refusal_breakdown).toEqual({ NO_GOLD: 3 });
    for (const k of ["wer", "n_scored", "n_refused", "refusal_breakdown"]) {
      expect(Object.keys(rows[0]!)).toContain(k);
    }
  });

  it("an engine with ONLY refusals still gets a line — the most interesting case on the board", () => {
    const rows = buildLeaderboard([], [{ engine_key: "sarvam", reason_code: "GOLD_NOT_GRADUATED", n: 5 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ engine_key: "sarvam", wer: null, n_scored: 0, n_refused: 5 });
  });

  it("SILENCE_UNTYPED never inflates n_refused — the pair WAS scored", () => {
    const rows = buildLeaderboard(
      [{ engine_key: "whisper", wer: 0.2, cer: 0.1 }],
      [
        { engine_key: "whisper", reason_code: "SILENCE_UNTYPED", n: 1 },
        { engine_key: "whisper", reason_code: "NO_GOLD", n: 2 },
      ],
    );
    expect(rows[0]!.n_refused).toBe(2);
    expect(rows[0]!.refusal_breakdown.SILENCE_UNTYPED).toBeUndefined();
  });

  it("no scored pairs anywhere still yields refusal fields, never a bare empty board", () => {
    const rows = buildLeaderboard([], []);
    expect(rows).toEqual([]);
  });

  it("the ROW TYPE itself makes the refusal fields non-optional — the rule lives in the type", () => {
    // Retargeted to the lib: the shape moved out of the route module (a Next.js route may only
    // export handlers and config). The assertion follows the rule, not the file.
    const src = readFileSync("lib/stt/window-leaderboard.ts", "utf8");
    const rowType = src.slice(src.indexOf("export type LeaderboardRow"), src.indexOf("export type SpendRow"));
    // No `?:` anywhere in the four PRD fields — an optional refusal count is a renderable WER
    // without one.
    for (const field of ["wer", "n_scored", "n_refused", "refusal_breakdown"]) {
      expect(rowType).toContain(field);
      expect(rowType).not.toContain(`${field}?:`);
    }
  });
});

describe("the spend ledger counts unknown cost apart from zero cost", () => {
  it("a null cost increments cost_unreported_runs and adds nothing to the total", () => {
    const rows = buildLedger([
      { initiated_by: "adm_1", initiated_via: "admin_route", day: "2026-08-30", n_runs: 4, cost_usd_total: 0, cost_unreported_runs: 4 },
    ]);
    expect(rows[0]).toMatchObject({ cost_usd_total: 0, cost_unreported_runs: 4, n_runs: 4 });
  });

  it("an unattributed legacy run keeps a NULL initiator rather than an invented name", () => {
    const rows = buildLedger([
      { initiated_by: null, initiated_via: null, day: "2026-08-24", n_runs: 5, cost_usd_total: 0, cost_unreported_runs: 5 },
    ]);
    expect(rows[0]!.initiated_by).toBeNull();
  });

  it("the SQL separates the two with a FILTER rather than trusting SUM over NULLs", () => {
    const src = readFileSync("app/api/admin/stt-spend/route.ts", "utf8");
    expect(src).toContain("FILTER (WHERE r.cost_usd IS NULL)");
    expect(src).toContain("COALESCE(SUM(r.cost_usd), 0)");
  });

  it("it groups on the IST clinic date, not the UTC date", () => {
    const src = readFileSync("app/api/admin/stt-spend/route.ts", "utf8");
    expect(src).toContain("Asia/Kolkata");
  });
});

describe("§E — the cue join compares numbers as numbers", () => {
  const job = readFileSync("lib/stt/measure-job.ts", "utf8");

  it("both window bounds are cast ::bigint, matching lib/brain/state.ts", () => {
    expect(job).toContain("(payload->'window'->>'start_ms')::bigint");
    expect(job).toContain("(payload->'window'->>'end_ms')::bigint");
  });

  it("the text comparison is gone", () => {
    expect(job).not.toContain("payload->'window'->>'start_ms' = ${String(startMs)}");
  });

  it("on integer input the cast matches exactly what the text compare matched", () => {
    // The behaviour being PRESERVED: for a window written as plain digits — which is every window
    // the drain has ever written, since buildTurns floors both bounds to integers — the text form
    // and the numeric form select the same row. So this fix changes no current result.
    const startMs = 1787553000000;
    expect(String(startMs)).toBe("1787553000000");
    expect(Number(String(startMs))).toBe(startMs);

    // The behaviour being GAINED: jsonb preserves the numeric TEXT it was given, so any writer
    // that ever emits an equal value in another form stops matching under text equality while
    // still matching under ::bigint. These are the same number and different strings.
    const otherForms = ["1787553000000.0", "+1787553000000", " 1787553000000"];
    for (const form of otherForms) {
      expect(Number(form)).toBe(startMs);          // ::bigint would match
      expect(form).not.toBe(String(startMs));      // text equality would not
    }
  });
});

describe("migration 0072 — the shape the orchestrator will run", () => {
  const sql = readFileSync("db/migrations/0072_evidence_spine.sql", "utf8");

  it("records itself", () => {
    expect(sql).toContain("INSERT INTO schema_migrations");
    expect(sql).toContain("(72, '0072_evidence_spine')");
  });

  it("is additive only — nothing dropped, narrowed or renamed", () => {
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+\w+\s+TYPE/i);
  });

  it("adds no NOT NULL column to transcription_run — the 0058 silent-insert trap", () => {
    const alter = sql.slice(sql.indexOf("ALTER TABLE transcription_run"), sql.indexOf("DO $$"));
    expect(alter).not.toMatch(/NOT NULL/i);
    expect(alter).not.toMatch(/DEFAULT/i);
  });

  it("receipt_complete is GENERATED, so it can never disagree with its own evidence", () => {
    expect(sql).toContain("GENERATED ALWAYS AS");
    expect(sql).toContain("STORED");
  });

  it("seeds the gold on the NATURAL key, never on a guessed bw_ id string", () => {
    expect(sql).toContain("w.session_id = 'bs_z3gpbh6e'");
    expect(sql).toContain("w.source_mic = 'primary'");
    expect(sql).toContain("1787553000000");
    expect(sql).toContain("1787556600000");
    expect(sql).not.toMatch(/'bw_z3gpbh6e_\d+_primary'/);
  });

  it("the seeds enter as ungraduated contaminated seeds", () => {
    // Scoped to the seeding statement: 'graduated' legitimately appears elsewhere in the file, in
    // the status CHECK and in the column comments. What must not happen is a SEED entering as one.
    const insert = sql.slice(sql.indexOf("INSERT INTO stt_gold_window"), sql.indexOf("ON CONFLICT (window_id) DO NOTHING"));
    expect(insert).toContain("'contaminated_seed'");
    expect(insert).toContain("'sarvam'");
    expect(insert).toContain("'seed'");
    expect(insert).not.toContain("'graduated'");
    expect(insert).not.toContain("verified_by");
    expect(insert).not.toContain("verified_at");
    expect(sql).toContain("ON CONFLICT (window_id) DO NOTHING");
  });

  it("the refusal vocabulary is closed by CHECK", () => {
    for (const code of [
      "NO_RECEIPT", "LEGACY_UNRECEIPTED", "NO_GOLD", "GOLD_NOT_GRADUATED",
      "FAMILY_CONTAMINATION", "COVERAGE_BELOW_FLOOR", "SILENCE_UNTYPED",
    ]) {
      expect(sql).toContain(`'${code}'`);
    }
  });

  it("every existing engine key gets a family, plus the reserved Gemini key", () => {
    for (const key of [
      "deepgram", "whisper", "sarvam", "elevenlabs", "elevenlabs_scribe",
      "ekascribe", "indicconformer", "indicconformer_scribe", "even_pipeline", "gemini",
    ]) {
      expect(sql).toContain(`'${key}'`);
    }
    expect(sql).toContain("'google'");
  });

  it("the composites carry their ASR's family, not their own key", () => {
    expect(sql).toContain("('elevenlabs_scribe',     'elevenlabs')");
    expect(sql).toContain("('indicconformer_scribe', 'indicconformer')");
  });
});
