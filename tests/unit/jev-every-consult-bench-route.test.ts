/**
 * JEV-EVERY-CONSULT S1 fix 1 (L1): the bench subjects route keeps the seeded EVR sample for pitch-detect and chair-affect (def.benchEligible),
 * while the sweeper's `eligible` is the every-consult source. No DB: both sources are mocked. Synthetic ids only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ evr: vi.fn(), every: vi.fn() }));
vi.mock("@/lib/room-access/evr-select", () => ({ selectEvrWindows: H.evr }));
vi.mock("@/lib/jev/worker/consult-eligible", () => ({ allTranscribedConsults: H.every, CONSULT_SUBJECT_TYPE: "consult" }));
vi.mock("@/lib/db", () => ({ sql: Object.assign(async () => [], { transaction: async () => [] }) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/jev/bench/subjects/route";
import { getUse } from "@/lib/jev/worker/uses";

const call = (qs: string) => GET(new NextRequest(`http://x/api/admin/jev/bench/subjects?${qs}`, { headers: { authorization: "Bearer test-secret" } }));

describe("bench subjects route keeps the seeded EVR sample", () => {
  beforeEach(() => { process.env.CRON_SECRET = "test-secret"; H.evr.mockReset().mockResolvedValue(["cx_b1@ma"]); H.every.mockReset().mockResolvedValue(["cx_e1@ma"]); });
  for (const set of ["pitch-detect", "chair-affect"]) {
    it(`${set}: the route calls selectEvrWindows, not the every-consult source`, async () => {
      const res = await call(`use=consult_rubric&set=${set}&limit=5`);
      expect(await res.json()).toMatchObject({ set, subject_ids: ["cx_b1@ma"] });
      expect(H.evr).toHaveBeenCalledTimes(1);
      expect(H.every).not.toHaveBeenCalled();
    });
    it(`${set}: the sweeper's eligible is the every-consult source`, async () => {
      expect(await getUse("consult_rubric", set)!.eligible(5, { sha: "s", mode: "shadow" })).toEqual(["cx_e1@ma"]);
      expect(H.every).toHaveBeenCalledWith(5, { sha: "s", mode: "shadow" });
    });
  }
});
