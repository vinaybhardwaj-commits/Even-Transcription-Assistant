/**
 * GUARD: no real clinician id may appear anywhere under tests/.
 *
 * A real doctor's id and name reached a pushed public branch through a test fixture in C2, and the
 * branch history had to be rewritten to remove them. This makes the next one fail the gate instead.
 *
 * THE ROSTER IS COMMITTED AS SHA-256 DIGESTS, NOT AS IDS. The list exists to keep real ids out of
 * this public repo; writing the ids themselves into it would publish exactly what it guards. Every
 * `doc_…` token found under tests/ is hashed and compared. It runs offline — no live query.
 *
 * The seven digests are the voiceprint roster as of 13 Sep 2026 (scribe_list_voiceprints). When a
 * clinician is enrolled, add the sha256 of their `doc_` id here — never the id.
 *
 * Synthetic ids in tests should carry a 0 or 1 (`doc_fake0001`): the app's id alphabet
 * (`abcdefghjkmnpqrstuvwxyz23456789`, lib/clinician-mint.ts) never uses either, so such an id can
 * never collide with a real clinician.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const ROSTER_ID_SHA256 = new Set([
  "c3b34fe007b49e4478f8ba30d5246d49a0d2e70e3d941637ed53f285c55884e3",
  "e09ec3bfa97d68112296881ed273020f1187ab831fc33d2b08b26af81c71c0be",
  "461414f7d864aeb8c2f4f7d0203049558f4a15cb785b64926aedc7ab545dc3c2",
  "497206e7b560dcbe509ae59cc51128491eeae3973a069e30b59cfe6ea62e5950",
  "31644332e5deace2a6a3c759f0f998598ee36e0ed54005bcdc1bb749e4e7c305",
  "07ea9e518e5cbb1fccbd3478fc7cf16b37a0a20b28ae767ab988fb11ab7e8dbe",
  "8604da671f752c144d6c17ecc80a1ce17cd742b6e4dab8255f147015a87f0899",
]);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Every `doc_` token in a text — quoted, in SQL, in a URL, anywhere. */
export function rosterIdsIn(text: string, roster: Set<string> = ROSTER_ID_SHA256): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(/doc_[A-Za-z0-9]+/g)) if (roster.has(sha(m[0]))) hits.push(m[0]);
  return hits;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("GUARD — no real clinician id under tests/", () => {
  it("the committed roster is seven distinct digests", () => {
    expect(ROSTER_ID_SHA256.size).toBe(7);
    for (const d of ROSTER_ID_SHA256) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  it("THE MATCHER WORKS: a planted id is found wherever it sits (checked against a synthetic roster)", () => {
    const planted = new Set([sha("doc_fake0001")]);
    for (const text of [
      `const id = "doc_fake0001";`,
      `INSERT INTO clinician VALUES ('doc_fake0001','x');`,
      `https://x.test/doctors/doc_fake0001/edit`,
      `{"clinician_id":"doc_fake0001"}`,
    ]) {
      expect(rosterIdsIn(text, planted), text).toEqual(["doc_fake0001"]);
    }
    // A longer token is a different id, not a match on its prefix.
    expect(rosterIdsIn(`doc_fake00012`, planted)).toEqual([]);
  });

  it("no file under tests/ contains an id from the live voiceprint roster", () => {
    const offenders: string[] = [];
    for (const f of filesUnder("tests")) {
      const text = readFileSync(f).toString("utf8");
      // Name the file, never the id — the report of a leak must not repeat it.
      if (rosterIdsIn(text).length > 0) offenders.push(f);
    }
    expect(offenders, "replace with a synthetic id such as doc_fake0001").toEqual([]);
  });
});
