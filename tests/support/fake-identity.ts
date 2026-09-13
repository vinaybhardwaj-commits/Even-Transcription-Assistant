/**
 * tests/support/fake-identity.ts — THE ONE PLACE a test gets a person.
 *
 * This repo is public. A real doctor's id and name reached a pushed branch through a test fixture,
 * and a name blocklist would only republish the names it blocks. So identity literals are not
 * allowed in test files at all (tests/unit/no-identity-literals.test.ts): a fixture that needs a
 * clinician, an operator or an email builds one here. Everything this returns is obviously fake,
 * and every id carries a 0 or 1 — outside the app's id alphabet — so it can never be a real one.
 */
import { slugifyName } from "@/lib/doctor-slug";

export type FakeClinician = {
  id: string;
  full_name: string;
  /** "Dr Fake Clinician N" — for labels such as a room name or a speaker label. */
  label: string;
  email: string;
  url_token: string;
  url_slug: string;
};

const pad = (n: number) => String(n).padStart(4, "0");

/** A fake clinician. `n` makes it distinct; the same `n` always gives the same identity. */
export function makeFakeClinician(n = 1): FakeClinician {
  const full_name = `Fake Clinician ${pad(n)}`;
  const url_token = "fake";
  return {
    id: `doc_fake${pad(n)}`,
    full_name,
    label: `Dr ${full_name}`,
    email: `fake.clinician.${pad(n)}@example.test`,
    url_token,
    url_slug: `${slugifyName(full_name)}-${url_token}`,
  };
}

/** A fake operator or admin — the person who publishes a release or signs in to the admin UI. */
export function makeFakeOperator(n = 1): { id: string; name: string; email: string } {
  return { id: `adm_fake${pad(n)}`, name: `fake-operator-${pad(n)}`, email: `fake.operator.${pad(n)}@example.test` };
}
