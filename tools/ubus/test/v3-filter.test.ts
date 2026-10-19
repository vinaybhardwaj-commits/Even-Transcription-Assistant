import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { filterText } from "../src/filter.js";
import { AllowList, checkFilter, openHub } from "../src/v3/hub.js";
import { caller, setup } from "./helpers.js";

const ALLOW_SEED = { terms: ["Human RAG", "Encounter Buddy", "newcat", "T28b"] };

function allowDir(): string {
  return mkdtempSync(join(tmpdir(), "ubus-allow-"));
}

test("the sentence from the acceptance list passes the filter", () => {
  const dir = allowDir();
  try {
    const file = join(dir, "allowlist.json");
    writeFileSync(file, JSON.stringify(ALLOW_SEED));
    const allow = new AllowList(file);
    const sentence = "Human RAG plan for Encounter Buddy, see newcat T28b";
    const verdict = checkFilter(sentence, allow);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    assert.equal(filterText(sentence).ok, true);
    const hits = allow.matches(sentence);
    assert.equal(hits.includes("Human RAG"), true);
    assert.equal(hits.includes("newcat"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a PHI-like synthetic string is rejected with a rule id and spans, never the matched text", () => {
  const rig = setup();
  try {
    const hub = openHub({
      dbPath: join(rig.dir, "v3", "eventlog.db"),
      clock: rig.clock,
      allowlistPath: join(rig.dir, "allowlist.json"),
    });
    try {
      const phone = hub.send(
        { to: ["fable"], subject: "contact", body: "phone 9000000001 callback" },
        caller("fable"),
      );
      assert.equal(phone.ok, false, JSON.stringify(phone));
      assert.equal(phone.error, "phi_filter");
      assert.equal(phone.reason, "phi_filter:phi.phone_in");
      assert.equal(phone.rule_id, "phi.phone_in");
      const spans = phone.spans as Array<[number, number]>;
      assert.ok(Array.isArray(spans) && spans.length >= 1, JSON.stringify(spans));
      const checked = "contact\nphone 9000000001 callback";
      const [start, end] = spans[0]!;
      assert.equal(checked.slice(start, end), "9000000001");
      const flat = JSON.stringify(phone);
      assert.equal(flat.includes("9000000001"), false, flat);

      const uid = hub.send(
        { to: ["fable"], subject: "chart", body: "uhid: AB12-3456 follow-up" },
        caller("fable"),
      );
      assert.equal(uid.ok, false, JSON.stringify(uid));
      assert.equal(uid.reason, "phi_filter:phi.uhid_mrn");
      assert.equal(uid.rule_id, "phi.uhid_mrn");
      const uidSpans = uid.spans as Array<[number, number]>;
      assert.ok(uidSpans.length >= 1, JSON.stringify(uidSpans));
      const uidChecked = "chart\nuhid: AB12-3456 follow-up";
      const [us, ue] = uidSpans[0]!;
      assert.match(uidChecked.slice(us, ue), /AB12-3456/);
      assert.equal(JSON.stringify(uid).includes("AB12-3456"), false, JSON.stringify(uid));

      assert.equal(existsSync(join(rig.dir, "v3", "eventlog.db")), true, "the event log exists but holds no message");
      assert.equal(hub.messages.snapshot().messages.length, 0, "a rejected send stores no message");
    } finally {
      hub.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("the allow-list reloads when the config file mtime changes and carries agent ids", () => {
  const dir = allowDir();
  try {
    const file = join(dir, "allowlist.json");
    writeFileSync(file, JSON.stringify({ terms: ["alpha-term"] }));
    const allow = new AllowList(file, () => ["worker"]);
    assert.equal(allow.terms().includes("alpha-term"), true);
    assert.equal(allow.terms().includes("worker"), true, "registered agent ids are terms");

    writeFileSync(file, JSON.stringify({ terms: ["beta-term"] }));
    const later = new Date(Date.now() + 2000);
    utimesSync(file, later, later);
    assert.equal(allow.terms().includes("beta-term"), true, "reloaded on mtime change");
    assert.equal(allow.terms().includes("alpha-term"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the v3 filter never disagrees with the hard rules in src/filter.ts", () => {
  const rig = setup();
  try {
    // An explicit empty allow-list: parity must be exact when nothing is listed.
    const emptyFile = join(rig.dir, "empty-allowlist.json");
    writeFileSync(emptyFile, JSON.stringify({ terms: [] }));
    const allow = new AllowList(emptyFile, () => []);
    const corpus = [
      "Human RAG plan for Encounter Buddy, see newcat T28b",
      "count=1 path=~/dev/eta-lab/out.json",
      "phone 9000000001 callback",
      "uhid: AB12-3456 follow-up",
      "token=sk-SUPERSECRETTOKENVALUE999999",
      "mail me at someone@example.com about it",
      "aadhaar 1234 5678 9012 copies",
      "call the pharmacy re prescription refill today",
      "doctor: the patient agrees\npatient: yes I do",
      "fable: please review the plan",
      "the fever settled after the tablet course today and the cough went away. the patient slept through the night without any complaint at all. the dosage was reviewed by the team this morning. the prescription was changed to a lower dose tonight.",
      "eight words in this sentence make it long enough here now. eight more words here make this one long too. and eight words again in this following sentence here. plus eight words in a sentence that keeps going. another sentence with eight whole words in it. this one also has eight words sitting here. eight words once more in this sentence. and the last one has eight words as well.",
      "\u0900".repeat(31),
    ];
    for (const text of corpus) {
      const hard = filterText(text);
      const soft = checkFilter(text, allow);
      assert.equal(soft.ok, hard.ok, `verdict differs for ${JSON.stringify(text)}`);
      if (!hard.ok && !soft.ok) {
        assert.equal(soft.rule_id, hard.rule, `rule id differs for ${JSON.stringify(text)}`);
        assert.ok(Array.isArray(soft.spans));
      }
      if (!soft.ok) assert.equal(soft.reason, `phi_filter:${soft.rule_id}`);
    }
  } finally {
    rig.cleanup();
  }
});

test("R2-3: an allow-listed term inside a PHI string is still rejected (the allow-list cannot override)", () => {
  const dir = allowDir();
  const rig = setup();
  try {
    const file = join(dir, "allowlist.json");
    // Every suspicious value is itself allow-listed: the hard rules must still win.
    writeFileSync(file, JSON.stringify({ terms: ["Human RAG", "Encounter Buddy", "9000000001", "patient", "ZZ00TEST01"] }));
    const allow = new AllowList(file);
    const subject = `Encounter Buddy 9000000001 Human RAG`;
    const verdict = checkFilter(subject, allow);
    assert.equal(verdict.ok, false, "an allow-listed PHI string was let through");
    assert.match(verdict.reason ?? "", /^phi_filter:phi\./);
    assert.ok(verdict.spans.some(([s, e]) => subject.slice(s, e).includes("9000000001")), "span does not cover the phone");
    assert.equal(JSON.stringify(verdict).includes("9000000001"), false, "matched text echoed");

    const hub = openHub({ dbPath: join(rig.dir, "v3", "eventlog.db"), clock: rig.clock, allowlistPath: file });
    try {
      const sent = hub.send({ to: ["fable"], subject, body: "count=1" }, caller("fable"));
      assert.equal(sent.ok, false, JSON.stringify(sent));
      const rejected = hub.inbox({ peek: true }, caller("fable"));
      assert.equal((rejected.messages as unknown[]).length, 0);

      // The soft half: a listed internal phrase passes (fails on the pre-R2 build).
      const soft = checkFilter("Encounter Buddy patient flow review", allow);
      assert.equal(soft.ok, true, "an allow-listed internal phrase must pass the soft name rule");
    } finally {
      hub.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rig.cleanup();
  }
});

test("R2-6: the allow-list exempts only the soft name rule, span by span, never a hard rule", () => {
  const dir = allowDir();
  const rig = setup();
  try {
    const file = join(dir, "allowlist.json");
    writeFileSync(file, JSON.stringify({ terms: ["Encounter Buddy", "9000000001", "ZZ00TEST01"] }));
    const allow = new AllowList(file);

    assert.equal(checkFilter("Encounter Buddy patient flow review", allow).ok, true, "listed phrase must pass");

    const phone = checkFilter(`Encounter Buddy 9000000001 Human RAG`, allow);
    assert.equal(phone.ok, false, "the allow-list exempted a phone number");
    assert.equal(phone.rule_id, "phi.phone_in");

    const uid = checkFilter(`UHID: ZZ00TEST01 follow up`, allow);
    assert.equal(uid.ok, false, "the allow-list exempted a patient uid");
    assert.equal(uid.rule_id, "phi.uhid_mrn");

    const unlisted = checkFilter("Zorvak Quintell patient flow review", allow);
    assert.equal(unlisted.ok, false, "a name outside the allow-list still trips the soft rule");
    assert.equal(unlisted.rule_id, "phi.patient_name");
    assert.ok(unlisted.spans.some(([s, e]) => "Zorvak Quintell patient flow review".slice(s, e).includes("Zorvak")));

    const hub = openHub({ dbPath: join(rig.dir, "v3", "eventlog.db"), clock: rig.clock, allowlistPath: file });
    try {
      const okSend = hub.send({ to: ["fable"], subject: "Encounter Buddy patient flow review", body: "count=1" }, caller("fable"));
      assert.equal(okSend.ok, true, JSON.stringify(okSend));
      const badSend = hub.send({ to: ["fable"], subject: "flow", body: `call ${"9000000001"} back` }, caller("fable"));
      assert.equal(badSend.ok, false, JSON.stringify(badSend));
      assert.equal(badSend.rule_id, "phi.phone_in");
    } finally {
      hub.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rig.cleanup();
  }
});

test("R3-F1: terms match whole words only, and a name is exempt only when fully covered", () => {
  const shipped = join(process.cwd(), "config", "v3-allowlist.json");
  const allow = new AllowList(shipped, () => ["zorvak"]);
  const mustReject = [
    "Ravi Pathak admitted with fever",
    "patient Pathak",
    "Ravi Herdrson admitted",
    "Zorvak Quintell has fever",
    "Encounter Buddy patient Asha Verma",
  ];
  for (const text of mustReject) {
    const verdict = checkFilter(text, allow);
    assert.equal(verdict.ok, false, `must reject: ${JSON.stringify(text)}`);
    const reason = String((verdict as { reason?: string }).reason ?? "");
    assert.match(reason, /^phi_filter:/);
    for (const [start, end] of (verdict as { spans?: Array<[number, number]> }).spans ?? []) {
      assert.ok(0 <= start && start < end && end <= text.length, "span outside the text");
    }
    assert.equal(JSON.stringify(verdict).includes("Pathak"), false, "matched text echoed");
    assert.equal(JSON.stringify(verdict).includes("Quintell"), false, "matched text echoed");
  }
  assert.equal(checkFilter("Human RAG plan for Encounter Buddy, see newcat T28b", allow).ok, true);
  assert.equal(checkFilter("Encounter Buddy patient flow review", allow).ok, true);
});

test("R3-2: the allow-list load drops clinical words and terms shorter than 4 chars", () => {
  const dir = allowDir();
  try {
    const file = join(dir, "allowlist.json");
    writeFileSync(
      file,
      JSON.stringify({ terms: ["patient", "doctor", "admitted", "fever", "mr", "mrs", "dr", "ab", "xy", "pathak", "herdr", "count"] }),
    );
    const allow = new AllowList(file, () => ["worker", "dr"]);
    const terms = allow.terms();
    for (const dropped of ["patient", "doctor", "admitted", "fever", "mr", "mrs", "dr", "ab", "xy"]) {
      assert.equal(terms.includes(dropped), false, `term ${dropped} should not load`);
    }
    assert.deepEqual(terms, ["count", "herdr", "pathak", "worker"]);
    // "patient" and "fever" sit in this text but were dropped at load: only "pathak" matches.
    assert.deepEqual(allow.matches("the patient Pathak has fever"), ["pathak"]);
    assert.deepEqual(allow.spans("the patient Pathak has fever"), [[12, 18]]);

    // the shipped seed survives its own review untouched
    const shipped = new AllowList(join(process.cwd(), "config", "v3-allowlist.json"), () => []);
    const seed = JSON.parse(readFileSync(join(process.cwd(), "config", "v3-allowlist.json"), "utf8")) as { terms: string[] };
    assert.equal(shipped.terms().length, seed.terms.length, "a shipped seed term was dropped");
    for (const term of seed.terms) assert.equal(shipped.terms().includes(term), true, `seed term lost: ${term}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
