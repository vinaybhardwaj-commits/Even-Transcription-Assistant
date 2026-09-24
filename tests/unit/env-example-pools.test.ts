/**
 * .env.example documents EVERY service-pool setting (ruling 134.6). Counted from POOL_ENV in code, never typed by hand, so a service added to the pool
 * tomorrow cannot be left out of the example: this fails until it is there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { POOL_ENV, BULK_AGE_MINUTES_ENV, BULK_FALLBACK_LIVE_ENV } from "@/lib/service-pool";

const example = readFileSync(".env.example", "utf8");
const names = [...Object.values(POOL_ENV).flatMap((e) => [e.list, e.bulk]), BULK_AGE_MINUTES_ENV, BULK_FALLBACK_LIVE_ENV];

describe(".env.example — the pool settings", () => {
  it("there are 20 of them, and every one is present as a COMMENTED-OUT line (default off)", () => {
    expect(new Set(names).size).toBe(20);
    for (const n of names) {
      expect(example, n).toMatch(new RegExp(`^# ${n}=`, "m"));
      expect(example, `${n} must not be an ACTIVE assignment`).not.toMatch(new RegExp(`^${n}=`, "m"));
    }
  });
  it("the enable rule for the router pool is written next to them", () => {
    expect(example).toMatch(/leave ETA_ROUTER_URL untouched/i);
  });
});
