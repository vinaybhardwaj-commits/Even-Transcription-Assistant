/**
 * GUARD: no clinician id may appear anywhere in the tree unless it is on the synthetic allowlist.
 *
 * A real doctor's id reached a pushed public branch through a test fixture. The first guard listed
 * sha256 digests of the real ids — reversible, because the id alphabet and length are public, so
 * the list republished what it guarded. This one bans the SHAPE instead: any `doc_` id-shaped
 * token in any file fails, unless it is below. There is nothing to reverse, and it catches ids that
 * have not been enrolled yet.
 *
 * THE SHAPE is `doc_` + 8 of [a-z0-9]. The current minter uses a 31-character alphabet
 * (lib/clinician-mint.ts), but older ids came from a-z0-9 (the bootstrap route) — a real id can
 * contain an `l` — so the guard takes the wider set.
 *
 * TO ADD A SYNTHETIC ID: prefer makeFakeClinician() (tests/support/fake-identity.ts), which never
 * writes an id into a file. If a literal is unavoidable, use doc_fakeNNNN and add it here. Never add
 * an id that exists in any database.
 */
import { describe, it, expect } from "vitest";
import { repoFiles, textOf } from "../support/repo-files";

export const SYNTHETIC_CLINICIAN_IDS = new Set([
  // Illustrations in docs/ — confirmed absent from the live clinician table on 13 Sep 2026.
  "doc_3p4n9q2x",
  "doc_ab12cd34",
  // Test fixtures.
  "doc_fake0001", "doc_fake0002",
  "doc_fake0101", "doc_fake0102", "doc_fake0103", "doc_fake0104", "doc_fake0105", "doc_fake0106",
  "doc_fake0107", "doc_fake0108", "doc_fake0109", "doc_fake0110", "doc_fake0111",
  "doc_fake0201", "doc_fake0202", "doc_fake0203", "doc_fake0204",
  "doc_fake0999",
]);

export const CLINICIAN_ID_SHAPE = /(?<![A-Za-z0-9_])doc_[a-z0-9]{8}(?![A-Za-z0-9_])/g;

/** Id-shaped tokens in a text that are not on the allowlist. */
export function unlistedIds(text: string, allow: Set<string> = SYNTHETIC_CLINICIAN_IDS): string[] {
  return [...text.matchAll(CLINICIAN_ID_SHAPE)].map((m) => m[0]).filter((t) => !allow.has(t));
}

describe("GUARD — no clinician id outside the synthetic allowlist, anywhere in the tree", () => {
  it("THE MATCHER WORKS: a planted id is found wherever it sits, including an old-alphabet id", () => {
    // Built at runtime, so this file carries no id-shaped literal of its own.
    const planted = ["doc", "q7mz9kx4"].join("_");
    const oldAlphabet = ["doc", "k1lo0abc"].join("_");
    for (const text of [
      `const id = "${planted}";`,
      `INSERT INTO clinician VALUES ('${planted}','x');`,
      `https://x.test/doctors/${planted}/edit`,
      `{"clinician_id":"${planted}"}`,
      `| id | \`${planted}\` |`,
    ]) {
      expect(unlistedIds(text), text).toEqual([planted]);
    }
    expect(unlistedIds(`x ${oldAlphabet} y`)).toEqual([oldAlphabet]);
    // Allowlisted ids pass; a longer token is not an id of this shape.
    expect(unlistedIds(`"doc_fake0001" and ${planted}9`)).toEqual([]);
  });

  it("every allowlisted id has the shape — a stale entry cannot hide", () => {
    for (const id of SYNTHETIC_CLINICIAN_IDS) expect([...id.matchAll(CLINICIAN_ID_SHAPE)].map((m) => m[0]), id).toEqual([id]);
  });

  it("no file in the tree carries an id-shaped token that is not on the allowlist", () => {
    const offenders: string[] = [];
    for (const f of repoFiles()) {
      const text = textOf(f);
      if (text === null) continue;
      // Name the file and the count, never the id — the report of a leak must not repeat it.
      const n = unlistedIds(text).length;
      if (n > 0) offenders.push(`${f} (${n})`);
    }
    expect(offenders, "replace with makeFakeClinician() or an allowlisted doc_fakeNNNN").toEqual([]);
  });
});
