/** Rooms Live v1.7: the Steward lines (mapping table), the card line selection, the status strip. Pure. */
import { describe, it, expect } from "vitest";
import { cardLine, isChange, lineOf, sentenceOf, stripView, type StewardRowIn, type StewardStatus } from "@/lib/rooms-live/steward-lines";
import { statusFromRows } from "@/lib/rooms-live/steward-status";
import { readStewardLog } from "@/lib/rooms-live/read";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NOW = Date.parse("2026-10-08T12:50:00Z"); // 18:20 IST
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const row = (over: Partial<StewardRowIn>): StewardRowIn => ({ rule: "not_recording", action: "scribe_start", mode: "live", result: "ok: start_day acked", ts: "2026-10-08T02:00:00Z", pstate: null, ...over });

// The combinations named in the FLEET spec (measured over 48 h, 8 Oct 2026). The read-only role cannot SELECT steward_decisions, so the real distinct set could not be pulled:
// this is the spec's list, crossed with every mode and every result prefix the Steward writes (loop.ts, executor.ts, results.ts), plus the session_died state words.
const RULES = ["ok", "session_died", "doctor_away", "silent_no_consult", "device_missing", "device_missing_hold", "mic_fault", "mic_check_pending", "kiosk_asleep", "not_recording"];
const ACTIONS = ["none", "log_only", "message", "alert", "scribe_start", "scribe_restart", "ticket:wake"];
const MODES = ["live", "shadow"];
const RESULTS = ["ok: start_day acked", "pending: sent, awaiting ack", "sending", "failed: no ack after 60 s", "failed: start_day expired", "skipped: kiosk not listening", "shadow: would scribe_restart", "kill_switch", "blocked: live executor not enabled in P0", null];
const PSTATES = [null, "confirming", "cleared", "message_sent"];
// names that must never appear on the page, as whole tokens
const RAW = /(?:\b[a-z]+_[a-z_]+\b|\bticket:|\blog_only\b|\bnone\b)/;

describe("mapping table: no combination renders a raw rule / action / result name", () => {
  const combos: StewardRowIn[] = [];
  for (const rule of RULES) for (const action of ACTIONS) for (const mode of MODES) for (const result of RESULTS) for (const pstate of PSTATES) combos.push(row({ rule, action, mode, result, pstate }));

  it(`covers all ${combos.length} (rule x action x mode x result-prefix x state) combinations: a Steward sentence, no raw names`, () => {
    expect(combos.length).toBe(10 * 7 * 2 * 10 * 4);
    for (const c of combos) {
      const t = sentenceOf(c);
      expect(t, JSON.stringify(c)).toMatch(/^Steward /);
      expect(RAW.test(t), `${JSON.stringify(c)} -> ${t}`).toBe(false);
      for (const name of [...RULES, ...ACTIONS].filter((n) => n.includes("_") || n.includes(":"))) expect(t.includes(name), `${name} in ${t}`).toBe(false);
    }
  });

  it("an UNKNOWN rule, action or result prefix still renders words, never its own name", () => {
    for (const c of [row({ rule: "brand_new_rule", action: "brand_new_action" }), row({ rule: "brand_new_rule", action: "ticket:brand_new_ticket", mode: "shadow" }), row({ rule: "brand_new_rule", action: "log_only" }), row({ rule: "brand_new_rule", action: "message", result: "weird_prefix: x" }), row({ rule: "brand_new_rule", action: "alert", mode: "shadow", result: "zz_new" })]) {
      const t = sentenceOf(c);
      expect(RAW.test(t), t).toBe(false);
      expect(t).toMatch(/^Steward /);
    }
  });

  it("the spec's sample sentences, word for word (IST)", () => {
    expect(sentenceOf(row({ ts: "2026-10-08T02:00:00Z" }))).toBe("Steward started recording at 07:30");
    expect(sentenceOf(row({ rule: "session_died", action: "scribe_restart", ts: "2026-10-08T12:40:00Z" }))).toBe("Steward restarted recording at 18:10");
    expect(sentenceOf(row({ rule: "kiosk_asleep", action: "ticket:wake", ts: "2026-10-08T01:35:00Z" }))).toBe("Steward asked the kiosk to wake at 07:05");
    expect(sentenceOf(row({ rule: "session_died", action: "scribe_restart", mode: "shadow", result: "kill_switch", ts: "2026-10-08T12:40:00Z" }))).toBe("Steward would have restarted recording at 18:10 (watching only, not done)");
    expect(sentenceOf(row({ rule: "device_missing_hold", action: "log_only", mode: "shadow", result: null }))).toBe("Steward is holding restarts: the mic is missing");
    expect(sentenceOf(row({ result: "failed: no ack after 60 s", ts: "2026-10-08T02:00:00Z" }))).toBe("Steward tried to start recording at 07:30, the kiosk did not answer");
  });

  it("a live row whose result is not recognised is NEVER claimed as done", () => {
    expect(sentenceOf(row({ result: "mystery" }))).toContain("watching only");
    expect(lineOf(row({ result: null })).outcome).toBe("watching");
  });

  it("a message / alert names the reason in words; a session_died message is not the raw rule", () => {
    expect(sentenceOf(row({ rule: "session_died", action: "message", mode: "shadow", result: "shadow: would message", ts: "2026-10-08T12:45:00Z" }))).toBe("Steward would have messaged staff at 18:15: the recording stopped (watching only, not done)");
    expect(sentenceOf(row({ rule: "device_missing", action: "alert", ts: "2026-10-08T12:45:00Z" }))).toBe("Steward raised an alert at 18:15: the mic is missing");
  });
});

describe("S2: the one card line", () => {
  const hold = row({ rule: "device_missing_hold", action: "log_only", mode: "shadow", result: null, ts: iso(5) });
  it("the newest action of the last 60 min wins over a newer log_only row", () => {
    const l = cardLine([row({ ts: iso(50), action: "scribe_start" }), row({ rule: "session_died", action: "scribe_restart", ts: iso(20), mode: "shadow", result: "kill_switch" }), row({ action: "log_only", ts: iso(1) })], NOW);
    expect(l?.text).toBe("Steward would have restarted recording at 18:00 (watching only, not done)");
    expect(l?.mode).toBe("shadow");
  });
  it("an action older than 60 min is not shown; the hold line is, else nothing", () => {
    expect(cardLine([row({ ts: iso(61) })], NOW)).toBeNull();
    expect(cardLine([row({ ts: iso(61) }), hold], NOW)?.text).toBe("Steward is holding restarts: the mic is missing");
    expect(cardLine([], NOW)).toBeNull();
  });
  it("an action beats the hold line; a row from the future is ignored", () => {
    expect(cardLine([hold, row({ ts: iso(30) })], NOW)?.text).toMatch(/started recording/);
    expect(cardLine([row({ ts: new Date(NOW + 10 * 60_000).toISOString() })], NOW)).toBeNull();
  });
  it("S3: live actions, and messages / alerts in any mode, are changes; shadow actions, log_only and none are not", () => {
    expect([row({}), row({ action: "alert", mode: "shadow" }), row({ action: "message", mode: "shadow" }), row({ action: "scribe_start", mode: "shadow" }), row({ action: "log_only" }), row({ action: "none" })].map(isChange)).toEqual([true, true, true, false, false, false]);
  });
  it("S3 on the real 48 h combos: shadow scribe_start / scribe_restart / ticket rows are not changes; shadow message / alert rows are", () => {
    const csv = join(__dirname, "..", "fixtures", "rooms-live", "combos-48h.csv");
    const text = readFileSync(csv, "utf8");
    const rows = text.trim().split("\n").slice(1).map((l) => l.match(/^([^,]*),([^,]*),([^,]*),"?([^",]*)"?,/)!).map((m) => ({ rule: m[1]!, action: m[2]!, mode: m[3]!, result: m[4] || null }));
    expect(rows.length).toBeGreaterThan(20);
    const shadow = rows.filter((r) => r.mode !== "live");
    const shadowStarts = shadow.filter((r) => /^(scribe_start|scribe_restart|scribe_stop|ticket:)/.test(r.action));
    const shadowMsgs = shadow.filter((r) => r.action === "message" || r.action === "alert");
    expect(shadowStarts.length).toBeGreaterThan(0);
    expect(shadowMsgs.length).toBeGreaterThan(0);
    for (const r of shadowStarts) expect(isChange(row({ ...r, ts: "2026-10-08T02:00:00Z" })), `${r.rule}|${r.action}|${r.mode}`).toBe(false);
    for (const r of shadowMsgs) expect(isChange(row({ ...r, ts: "2026-10-08T02:00:00Z" })), `${r.rule}|${r.action}|${r.mode}`).toBe(true);
    for (const r of rows.filter((x) => x.mode === "live" && x.action !== "none" && x.action !== "log_only")) expect(isChange(row(r)), `${r.rule}|${r.action}|live`).toBe(true);
  });
  it("F2: live skipped: kiosk not listening says the kiosk was not ready; any other skipped says it was not sent", () => {
    const t = (result: string, action = "scribe_start") => sentenceOf(row({ action, mode: "live", result }));
    expect(t("skipped: kiosk not listening")).toBe("Steward did not start recording at 07:30, the kiosk was not ready");
    expect(t("skipped: budget")).toBe("Steward's request to start recording at 07:30 was not sent");
    expect(t("skipped: budget", "ticket:wake")).toBe("Steward's request to ask the kiosk to wake at 07:30 was not sent");
    expect(t("skipped: budget", "ticket:wake")).not.toMatch(/kiosk was not ready/);
  });
  it("F4: the Details read excludes none rows before the 20-per-room cut (keeps log_only)", async () => {
    let sqlText = "";
    const db = ((strings: TemplateStringsArray) => { sqlText = strings.join("?"); return Promise.resolve([]); }) as never;
    await readStewardLog(db, ["opd4"], "2026-10-08T12:50:00Z");
    const inner = sqlText.slice(sqlText.indexOf("FROM steward_decisions"), sqlText.indexOf(") x"));
    expect(inner).toMatch(/d\.action <> 'none'/);
    expect(inner).not.toMatch(/log_only/);
    expect(sqlText.indexOf("d.action <> 'none'")).toBeLessThan(sqlText.indexOf("rn <= 20"));
  });
});

describe("S1: the strip", () => {
  const on = (minAgo: number | null, o: Partial<Extract<StewardStatus, { state: "on" }>> = {}): StewardStatus => ({ state: "on", last_tick_at: minAgo === null ? null : iso(minAgo), starts_live: true, others: "watching", ...o });
  it("fresh: the spec's line, no alarm", () => {
    expect(stripView(on(1), NOW)).toEqual({ text: "Steward: checked 1 min ago · starts recording: ON · restarts and alerts: watching only", tone: "ok" });
    expect(stripView(on(0.2), NOW).text).toContain("checked under 1 min ago");
  });
  it("amber past 3 min, red past 10 min", () => {
    expect(stripView(on(3), NOW).tone).toBe("ok");
    expect(stripView(on(3.5), NOW).tone).toBe("amber");
    expect(stripView(on(10), NOW).tone).toBe("amber");
    expect(stripView(on(10.5), NOW).tone).toBe("red");
    expect(stripView(on(90), NOW).text).toContain("checked 90 min ago");
  });
  it("no last_tick at all is red, and says so", () => {
    expect(stripView(on(null), NOW)).toMatchObject({ tone: "red", text: expect.stringContaining("has not checked yet") });
  });
  it("kill switch on: 'Steward off'", () => {
    expect(stripView({ state: "off", last_tick_at: iso(1) }, NOW)).toEqual({ text: "Steward off", tone: "off" });
  });
  it("config unreadable (or no status at all): 'Steward status unavailable'", () => {
    expect(stripView({ state: "unavailable" }, NOW)).toEqual({ text: "Steward status unavailable", tone: "unavailable" });
    expect(stripView(undefined, NOW).text).toBe("Steward status unavailable");
  });
  it("starts off / others live read in words", () => {
    expect(stripView(on(1, { starts_live: false, others: "live" }), NOW).text).toBe("Steward: checked 1 min ago · starts recording: watching only · restarts and alerts: ON");
    expect(stripView(on(1, { others: "partly" }), NOW).text).toContain("partly ON");
  });
});

describe("S1: the status from steward_config rows (the Steward's own actionMode)", () => {
  const rows = (o: { kill?: unknown; shadow?: unknown; start?: unknown; tick?: unknown }) => [
    { key: "kill_switch", value: o.kill ?? { on: false } },
    { key: "shadow", value: o.shadow ?? { global: false, actions: { scribe_restart: true, alert: true, message: true, scribe_stop: true, "ticket:wake": true, "ticket:open_pulse": true, "ticket:relaunch_chrome": true, "ticket:policy_cycle": true, "ticket:restart_recorder_app": true, "ticket:restart_kiosk_health": true } } },
    { key: "start_day_live", value: o.start ?? { on: true } },
    { key: "last_tick", value: o.tick ?? { at: "2026-10-08T13:19:30.000Z", degraded: [] } },
  ];
  it("the measured 8 Oct state: starts live, everything else watching", () => {
    expect(statusFromRows(rows({}))).toEqual({ state: "on", last_tick_at: "2026-10-08T13:19:30.000Z", starts_live: true, others: "watching" });
  });
  it("kill switch on -> off; jsonb as strings is read", () => {
    expect(statusFromRows(rows({ kill: '{"on":true}' }))).toMatchObject({ state: "off" });
  });
  it("a missing or malformed kill_switch is UNAVAILABLE, never 'off' (parseConfig's fail-closed ON is not a fact about the Steward)", () => {
    expect(statusFromRows([])).toEqual({ state: "unavailable" });
    expect(statusFromRows(rows({ kill: "yes" }))).toEqual({ state: "unavailable" });
    expect(statusFromRows(rows({ shadow: 7 }))).toEqual({ state: "unavailable" });
  });
  it("shadow.global true: nothing is live; a missing last_tick is null", () => {
    expect(statusFromRows(rows({ shadow: { global: true } }))).toMatchObject({ starts_live: false, others: "watching" });
    expect(statusFromRows(rows({ tick: { nope: 1 } }))).toMatchObject({ last_tick_at: null });
  });
});
