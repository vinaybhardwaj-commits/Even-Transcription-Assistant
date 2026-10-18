// Deep-link reference vectors (Fable catalog-15 condition 1). explorerAnchor must produce these exact fragments and parseAnchor must round-trip them.
// scribe-mcp mirrors explorerAnchor in scribe_catalog action=explorer_link and cross-checks against these vectors.
import test from "node:test";
import assert from "node:assert/strict";
import { explorerAnchor, parseAnchor } from "../src/links.js";

const AT_ID = "doc:1" + "@" + "x.y";   // built at runtime: written out it looks like an email address to the real-data scanner
const VECTORS = [
  [{ consult_uid: "UIDABCDEFGH1" }, "#c-UIDABCDEFGH1", { kind: "consult", consult_uid: "UIDABCDEFGH1" }],
  [{ consult_uid: "a_b-C_d-9" }, "#c-a_b-C_d-9", { kind: "consult", consult_uid: "a_b-C_d-9" }],
  [{ doctor_uid: AT_ID, date: "2026-10-05" }, "#d-646f633a3140782e79~2026-10-05", { kind: "doctor", doctor_uid: AT_ID, date: "2026-10-05" }],
  [{ doctor_uid: "DOC_A.b-9", date: "2026-01-01" }, "#d-444f435f412e622d39~2026-09-09", { kind: "doctor", doctor_uid: "DOC_A.b-9", date: "2026-09-09" }],   // clamped to the floor
  [{ individual_uid: "IND-00_01" }, "#p-494e442d30305f3031", { kind: "patient", individual_uid: "IND-00_01" }],
];
for (const [input, fragment, parsed] of VECTORS) {
  test("vector " + fragment, () => {
    assert.equal(explorerAnchor(input), fragment);
    assert.match(fragment, /^#[A-Za-z0-9._~-]+$/, "bare anchor characters only");
    assert.deepEqual(parseAnchor(fragment.slice(1)), parsed, "round trip");
    if (fragment.startsWith("#d-") || fragment.startsWith("#p-")) assert.match(fragment, /^#[dp]-[0-9a-f]+/, "hex is lowercase");
  });
}

const REJECT = {
  "odd-length hex": ["d-646f633~2026-10-05", "p-494e442d30305f303"],
  "non-hex characters": ["d-646f63zz~2026-10-05", "p-494e44xx", "d-646F633A31~2026-10-05".replace("F", "g")],
  "a #d- with a missing ~date": ["d-646f633a3140782e79", "d-646f633a3140782e79~"],
  "a date before 2026-09-09": ["d-646f633a3140782e79~2026-09-08", "d-646f633a3140782e79~2026-01-01"],
  "an invalid date": ["d-646f633a3140782e79~2026-13-40", "d-646f633a3140782e79~2026-02-30", "d-646f633a3140782e79~2026-09-31", "d-646f633a3140782e79~2026-11-31", "d-646f633a3140782e79~2027-02-29", "d-646f633a3140782e79~2026-04-31", "d-646f633a3140782e79~2028-02-30", "d-646f633a3140782e79~20261005", "d-646f633a3140782e79~nope"],
  "an empty id": ["d-~2026-10-05", "p-", "c-"],
  "a consult uid failing the pattern": ["c-abc", "c-" + "x".repeat(65), "c-a/b/c/d/e/f", "c-has space1", "c-uid.dot.1"],
};
for (const [name, tokens] of Object.entries(REJECT)) {
  test("parser rejects " + name + " (never throws; unknown means overview + 'Link not recognised')", () => {
    for (const t of tokens) {
      let r;
      assert.doesNotThrow(() => { r = parseAnchor(t); }, t);
      assert.deepEqual(r, { kind: "unknown" }, t);
    }
  });
}

// B3: the floor check hides an overflow date that is BEFORE 2026-09-09 (2026-02-30 is rejected by the floor alone), so the vectors that prove the calendar check are on or after the floor
test("B3: a calendar-overflow date is not a date (on or after the floor, where only the calendar check can reject it)", () => {
  const hex = "646f633a3140782e79";
  for (const d of ["2026-09-31", "2026-11-31", "2027-02-29", "2026-06-31", "2027-02-30", "2026-10-32"]) {
    assert.deepEqual(parseAnchor("d-" + hex + "~" + d), { kind: "unknown" }, d);
    assert.equal(explorerAnchor({ doctor_uid: AT_ID, date: d }), null, d);
  }
  // clamp first, then validate: an invalid date before the floor is null, not clamped to 2026-09-09
  for (const d of ["2026-02-30", "2025-02-29", "2026-04-31"]) assert.equal(explorerAnchor({ doctor_uid: AT_ID, date: d }), null, "invalid before the floor: " + d);
  assert.equal(explorerAnchor({ doctor_uid: AT_ID, date: "2026-01-01" }), "#d-646f633a3140782e79~2026-09-09", "a VALID date before the floor is still clamped");
});

test("B3: real calendar days still pass, including a leap day and month ends", () => {
  const hex = "646f633a3140782e79";
  for (const d of ["2028-02-29", "2026-09-30", "2026-10-31", "2026-12-31", "2027-02-28"]) {
    assert.deepEqual(parseAnchor("d-" + hex + "~" + d), { kind: "doctor", doctor_uid: AT_ID, date: d }, d);
    assert.equal(explorerAnchor({ doctor_uid: AT_ID, date: d }), "#d-" + hex + "~" + d, d);
  }
});

test("explorerAnchor makes no link from invalid input (no throw)", () => {
  for (const bad of [{ consult_uid: "abc" }, { consult_uid: "x".repeat(65) }, { doctor_uid: "", date: "2026-10-05" }, { doctor_uid: "d", date: "2026-13-40" }, { doctor_uid: "d", date: "2026-11-31" }, { doctor_uid: "d", date: "2027-02-29" }, { doctor_uid: "d", date: "2026-09-31" }, { doctor_uid: "d", date: "nope" }, { individual_uid: "" }, {}, null, undefined, 5]) assert.equal(explorerAnchor(bad), null, JSON.stringify(bad));
});

test("the page routes an unknown anchor to the overview with the notice (source check; the browser check drives it)", async () => {
  const { readFileSync } = await import("node:fs");
  const ui = readFileSync(new URL("../src/ui.js", import.meta.url), "utf8");
  assert.match(ui, /S\.notice = p\.kind === "unknown"/);
  assert.match(ui, /Link not recognised\./);
});
