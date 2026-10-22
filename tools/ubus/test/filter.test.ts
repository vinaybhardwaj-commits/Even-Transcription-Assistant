import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addressDenied, extractToTag, originTag, parseAddress } from "../src/address.js";
import { loadClientSettings } from "../src/client-config.js";
import { isDeniedMachine } from "../src/constants.js";
import { deriveIdentity } from "../src/derive.js";
import { filterFields, filterPath, filterText, type FilterResult } from "../src/filter.js";
import { decideStop } from "../src/hooklib.js";

/** Identity and key-header literals are assembled at run time so the repo never holds them. */
const TS_HOST = ["mini", "tail000000", "ts", "net"].join(".");
const ICUS = ["ehrc", "icus", "mac", "mini"].join("-");
const PEM = `-----${"BEGIN"} ${"PRIVATE"} KEY-----\nabc\n-----END ${"PRIVATE"} KEY-----`;

function reason(result: FilterResult): string {
  assert.equal(result.ok, false);
  if (result.ok) return "";
  return result.reason;
}

function rule(result: FilterResult): string {
  assert.equal(result.ok, false);
  if (result.ok) return "";
  return result.rule;
}

const KIOSK_NOTE =
  "From Grok Bot for Vinay. From 10:30 IST you own kiosk repair and self-healing for today. Liason starts all rooms at 09:00. Bug Bot checks every 10 min from 09:01 and sends each downtime to you; attempt repair or self-heal and reply to bug-bot and grok-bot with the outcome. Three kiosks (OPD 5, OPD 7, Dietary) are offline and need on-site help. Full context: ETA bus post 11533.";

test("filter allows operational notes and rejects phi, secrets, transcripts, and secret paths", () => {
  assert.equal(filterText("path=~/dev/eta-lab/out.json count=3 verdict=ok").ok, true);
  assert.equal(reason(filterText("patient MRN: ABC12345 admitted")), "phi_suspect");
  assert.equal(filterText("UHID: ZX-998877 needs a chart").ok, false);
  assert.equal(filterText("call +919876543210").ok, false);
  assert.equal(reason(filterText("token=sk-SUPERSECRETTOKENVALUE999999")), "secret");
  assert.equal(rule(filterText("token=sk-SUPERSECRETTOKENVALUE999999")), "secret.openai");
  assert.equal(reason(filterText(PEM)), "secret");
  assert.equal(rule(filterText(PEM)), "secret.private_key");
  assert.equal(reason(filterText("postgres://ubus:s3cr3tpass@example.test/bus")), "secret");
  assert.equal(rule(filterText("postgres://ubus:s3cr3tpass@example.test/bus")), "secret.connection_uri");
  const prose = [
    "The patient described a long week of poor sleep and morning headaches.",
    "The clinician asked about medicines taken during the previous month.",
    "They then discussed a walking plan and a follow up in two weeks.",
    "The visit ended with a note to bring the paper file next time.",
  ].join(" ");
  assert.equal(reason(filterText(prose)), "transcript");
  assert.equal(rule(filterText(prose)), "transcript.clinical_prose");
  assert.equal(reason(filterPath("~/.ssh/id_ed25519")), "secret_path");
  assert.equal(rule(filterPath("~/.ssh/id_ed25519")), "path.ssh");
  assert.equal(reason(filterPath("/home/box/shared/llm-gateway/secrets/key.json")), "secret_path");
  assert.equal(reason(filterPath("~/dev/Neon Database Connection String.rtf")), "secret_path");
  assert.equal(filterPath("~/dev/eta-lab/out.json").ok, true);
});

test("operational kiosk text passes, and rejections name a rule id only", () => {
  assert.equal(filterText(KIOSK_NOTE).ok, true);
  const withSubject = filterFields(["You own kiosk repair and self-healing for today.", KIOSK_NOTE]);
  assert.equal(withSubject.ok, true);
  for (const fragment of ["OPD 5", "OPD 7", "Dietary", "10:30", "09:00", "09:01", "post 11533", "bug-bot", "grok-bot", "From Grok Bot for Vinay"]) {
    assert.equal(filterText(fragment).ok, true, fragment);
  }
  assert.equal(filterText("Ramesh Kumar sent the build log to bug-bot").ok, true);

  const phone = filterText("call +919876543210");
  assert.equal(rule(phone), "phi.phone_in");
  assert.equal(JSON.stringify(phone).includes("9876543210"), false);
  assert.equal(rule(filterText("desk 9876543210")), "phi.phone_in");
  assert.equal(rule(filterText("call 415-555-0199")), "phi.phone_us");
  assert.equal(rule(filterText("UHID: ZX-998877 needs a chart")), "phi.uhid_mrn");
  assert.equal(rule(filterText("aadhaar 1234 5678 9012 on file")), "phi.aadhaar");
  assert.equal(rule(filterText("write vinay@example.com")), "phi.email");
  assert.equal(rule(filterText("ref 123456789012")), "phi.long_digit_run");
  assert.equal(filterText("post 1153377").ok, true);
  const named = filterText("patient Ramesh Kumar was admitted yesterday");
  assert.equal(rule(named), "phi.patient_name");
  assert.equal(JSON.stringify(named).includes("Ramesh"), false);
  assert.equal(rule(filterText("क".repeat(30))), "transcript.devanagari");
  assert.equal(rule(filterText("Doctor: hello there\nPatient: I have been unwell")), "transcript.speakers");
});

test("kiosk and orb machines are denied, ordinary machines are not", () => {
  assert.equal(isDeniedMachine("ehrc-test-1"), true);
  assert.equal(isDeniedMachine(ICUS), true);
  assert.equal(isDeniedMachine("vinay-orb2"), true);
  assert.equal(isDeniedMachine("orb2"), true);
  assert.equal(isDeniedMachine("mini"), false);
  assert.equal(addressDenied(`agent://${ICUS}/claude-code/herdr:default/x`), true);
  assert.equal(addressDenied("agent://mini/claude-code/herdr:default/eta-refuter"), false);
  const parsed = parseAddress("agent://mini/claude-code/herdr:default/eta-refuter");
  assert.equal(parsed?.session, "herdr:default/eta-refuter");
  assert.equal(originTag("grok:designer"), "designer");
  assert.equal(extractToTag("[to:grok:designer] ping", "count=1"), "grok:designer");
});

test("herdr panes derive one stable handle for the hook and the shim", () => {
  const env = { HERDR_AGENT_NAME: "eta-refuter", HERDR_SESSION: "default", UBUS_MACHINE: "mini", UBUS_RUNTIME: "claude-code" } as NodeJS.ProcessEnv;
  const a = deriveIdentity(env);
  const b = deriveIdentity(env, { session_id: "different", cwd: "/tmp/other" });
  assert.deepEqual(a, b);
  assert.equal(a.handle, "eta-refuter");
  assert.equal(a.session, "herdr:default/eta-refuter");
});

test("stop hook blocks unread mail at most once per ten minutes", () => {
  const unread = { count: 2, ids: ["ubus:aaa", "ubus:bbb"], from: ["fable"] };
  const now = Date.parse("2026-10-11T08:00:00Z");
  const first = decideStop({ unread, lastBlockAt: null, now });
  assert.equal(first.block, true);
  assert.match(first.reason || "", /ubus:aaa/);
  assert.doesNotMatch(first.reason || "", /subject/i);
  const second = decideStop({ unread, lastBlockAt: new Date(now).toISOString(), now: now + 60_000 });
  assert.equal(second.block, false);
  const later = decideStop({ unread, lastBlockAt: new Date(now).toISOString(), now: now + 10 * 60 * 1000 + 1 });
  assert.equal(later.block, true);
  assert.equal(decideStop({ unread: { count: 0, ids: [], from: [] }, lastBlockAt: null, now }).block, false);
});

test("client settings prefer UBUS_URL, then the local url, then the door", () => {
  const dir = mkdtempSync(join(tmpdir(), "ubus-client-"));
  const file = join(dir, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      url: "http://127.0.0.1:8790/mcp",
      tailnet_url: `https://${TS_HOST}/ubus/mcp`,
      cf_url: "https://bus.llmvinayminihome.uk/mcp",
    }),
  );
  assert.equal(loadClientSettings({ UBUS_CLIENT_CONFIG: file }).url, "http://127.0.0.1:8790/mcp");
  assert.equal(loadClientSettings({ UBUS_CLIENT_CONFIG: file, UBUS_DOOR: "tailnet" }).url, `https://${TS_HOST}/ubus/mcp`);
  assert.equal(loadClientSettings({ UBUS_CLIENT_CONFIG: file, UBUS_URL: "http://127.0.0.1:9/mcp" }).url, "http://127.0.0.1:9/mcp");
});
