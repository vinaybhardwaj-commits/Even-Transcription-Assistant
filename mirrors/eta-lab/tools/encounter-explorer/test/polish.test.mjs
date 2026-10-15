// Lead polish items and refute R2 nits: shade steps, IST stamps, one object URL at a time.
import test from "node:test";
import assert from "node:assert/strict";
import { createFixtureImpl } from "../src/adapter-fixture.js";
import { istStamp, shadeLevel, SHADE_LABELS } from "../src/util.js";
import { mockupData } from "./helpers.mjs";

test("P1: shade is five steps, grey for clipped only through darkest for nearly complete", () => {
  assert.equal(SHADE_LABELS.length, 5);
  assert.deepEqual([0, 0.34, 0.35, 0.54, 0.55, 0.69, 0.7, 0.84, 0.85, 1].map(shadeLevel), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  for (const bad of [NaN, undefined, null, -1]) assert.equal(shadeLevel(bad), 0);
});

test("N9: UTC timestamps are shown as IST", () => {
  assert.equal(istStamp("2026-09-09T04:10:19.000Z"), "2026-09-09 09:40:19");
  assert.equal(istStamp("2026-09-09T20:00:00Z"), "2026-09-10 01:30:00");
  assert.equal(istStamp("not a time"), "not a time");
  assert.equal(istStamp(null), null);
});

test("N11: opening another consult revokes the previous audio object URL", async () => {
  const made = [], revoked = [];
  const URLc = globalThis.URL, create = URLc.createObjectURL, revoke = URLc.revokeObjectURL;
  URLc.createObjectURL = () => { const u = "blob:syn-" + made.length; made.push(u); return u; };
  URLc.revokeObjectURL = u => revoked.push(u);
  try {
    const impl = createFixtureImpl(mockupData());
    const withT = mockupData().consults.filter(c => c.transcript).slice(0, 3);
    for (const c of withT) await impl.getAudioUrl(c.consult_uid);
    assert.equal(made.length, 3);
    assert.deepEqual(revoked, ["blob:syn-0", "blob:syn-1"]);
  } finally { URLc.createObjectURL = create; URLc.revokeObjectURL = revoke; }
});
