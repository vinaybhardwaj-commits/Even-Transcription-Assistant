/**
 * CHECK: a test file may not hard-code a person.
 *
 * A name blocklist would republish the names it blocks, so this bans the SHAPES an identity takes
 * in a fixture. A test that needs a clinician, an operator or an email gets one from
 * tests/support/fake-identity.ts (makeFakeClinician / makeFakeOperator), which is the one file
 * allowed to write these shapes.
 *
 * SCOPE: every test-like file in the WHOLE TREE, not only tests/ — *.test.* and *.spec.* anywhere,
 * and anything under a tests/, __tests__/, e2e/, fixtures/ or Tests/ directory (the Swift targets
 * included). Same file set as the id guard (tests/support/repo-files.ts).
 *
 * THE SHAPES, each reported by file, line and rule — never the value:
 *   doctor-slug     a slug literal: dr-<name>[-<name>]-<4-char token>
 *   identity-field  a string literal on a person field: full_name, display_name, doctor_name,
 *                   clinician_name, patient_name, first_name, last_name, surname, published_by
 *                   (snake or camel case)
 *   dr-title        "Dr" / "Dr." / "Doctor" followed by a capitalised word, inside a string
 *   slug-from-name  buildDoctorSlug( or slugifyName( called on a string literal
 *   email           an email address at any domain other than example.com/.org/.net/.test
 */
import { describe, it, expect } from "vitest";
import { repoFiles, textOf } from "../support/repo-files";

const TESTLIKE = /(^|\/)(tests?|__tests__|e2e|fixtures|Tests)\/|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.swift$/;
const EXEMPT = new Set(["tests/support/fake-identity.ts", "tests/unit/no-identity-literals.test.ts"]);

const PERSON_FIELD = "full_?name|fullName|display_?name|displayName|doctor_?name|doctorName|clinician_?name|clinicianName|patient_?name|patientName|first_?name|firstName|last_?name|lastName|surname|published_?by|publishedBy";

export const RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: "doctor-slug", re: /\bdr-[a-z]+(?:-[a-z]+)*-[a-z0-9]{4}\b/ },
  { rule: "identity-field", re: new RegExp(`\\b(?:${PERSON_FIELD})\\b["']?\\s*[:=]\\s*(["'\`])(?!\\1)[^"'\`\\n]+\\1`) },
  { rule: "dr-title", re: /["'`][^"'`\n]*\b(?:Dr\.?|Doctor)\s+[A-Z][a-z]+/ },
  // A quoted literal, or a template with no interpolation — a template built from a helper value passes.
  { rule: "slug-from-name", re: /\b(?:buildDoctorSlug|slugifyName)\(\s*(?:"[^"]*"|'[^']*'|`[^`$]*`)/ },
  { rule: "email", re: /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net|test)\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/ },
];

/** Every line of a text that breaks a rule, as {line, rule}. */
export function identityLiterals(text: string): Array<{ line: number; rule: string }> {
  const out: Array<{ line: number; rule: string }> = [];
  text.split("\n").forEach((l, i) => {
    for (const { rule, re } of RULES) if (re.test(l)) out.push({ line: i + 1, rule });
  });
  return out;
}

describe("CHECK — no identity literal in any test file in the tree", () => {
  it("THE RULES WORK: each planted shape is caught, and helper-built identities are not", () => {
    const planted: Array<[string, string]> = [
      [`const SLUG = "dr-jane-planted-ab2c";`, "doctor-slug"],
      [`room_slug: "opd-5-dr-planted-wxmp",`, "doctor-slug"],
      [`{ full_name: "Jane Planted" }`, "identity-field"],
      [`fullName = 'Jane Planted'`, "identity-field"],
      [`published_by: "jplanted",`, "identity-field"],
      [`room_name: "OPD 5 Dr Planted",`, "dr-title"],
      [`it("Dr. Planted: a dictation case", () => {`, "dr-title"],
      [`label: "Doctor Planted"`, "dr-title"],
      [`buildDoctorSlug("Jane Planted")`, "slug-from-name"],
      ["slugifyName(`Jane Planted`)", "slug-from-name"],
      [`email: "jane@hospital.in"`, "email"],
    ];
    for (const [line, rule] of planted) {
      expect(identityLiterals(line).map((h) => h.rule), line).toContain(rule);
    }
    for (const line of [
      "room_name: `OPD 5 ${FAKE_DOC.label}`,",
      "full_name: c.full_name,",
      "buildDoctorSlug(makeFakeClinician(2).full_name)",
      `email: "fake.operator.0001@example.test"`,
      `{ idx: 0, label: "Dr", type: "clinician" }`,
      `expect(full).toMatch(/^dr-fake-clinician-[a-z2-9]{4}$/)`,
      "slugifyName(`Dr. ${c.full_name}`)",
    ]) {
      expect(identityLiterals(line), line).toEqual([]);
    }
  });

  it("no test-like file anywhere in the tree hard-codes a person", () => {
    const offenders: string[] = [];
    for (const f of repoFiles()) {
      if (!TESTLIKE.test(f) || EXEMPT.has(f)) continue;
      const text = textOf(f);
      if (text === null) continue;
      for (const h of identityLiterals(text)) offenders.push(`${f}:${h.line} ${h.rule}`);
    }
    expect(offenders, "build the identity with makeFakeClinician / makeFakeOperator").toEqual([]);
  });
});
