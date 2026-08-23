/**
 * ROOM_STT_DRAIN_ENABLED (K4b Part A) — the flag that lets a room's tape be sent to a paid
 * engine. Monday 24 August is a live OPD day, so these tests are about one property: OFF FOR
 * EVERY CLINIC ROOM, and off by default.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ROOM_DRAIN_ENV,
  parseRoomDrainFlag,
  roomDrainFlagState,
  isRoomDrainEnabled,
} from "@/lib/stt/room-drain-flag";

const HOME_OFFICE = "room_2qe955hy";
const OPD7 = "room_qyzghzaf";
const CARDIOLOGY = "room_bh6jtq4t";

const original = process.env[ROOM_DRAIN_ENV];
afterEach(() => {
  if (original === undefined) delete process.env[ROOM_DRAIN_ENV];
  else process.env[ROOM_DRAIN_ENV] = original;
});

describe("A1 — default OFF", () => {
  it("unset enables nothing, for anybody", () => {
    delete process.env[ROOM_DRAIN_ENV];
    expect(isRoomDrainEnabled(HOME_OFFICE)).toBe(false);
    expect(isRoomDrainEnabled(OPD7)).toBe(false);
    expect(isRoomDrainEnabled(CARDIOLOGY)).toBe(false);
    expect(roomDrainFlagState().set).toBe(false);
  });

  it("an empty string is not a room", () => {
    process.env[ROOM_DRAIN_ENV] = "   ";
    expect(isRoomDrainEnabled(HOME_OFFICE)).toBe(false);
    expect(roomDrainFlagState().set).toBe(false);
  });

  it("no room id argument is never enabled", () => {
    process.env[ROOM_DRAIN_ENV] = HOME_OFFICE;
    expect(isRoomDrainEnabled("")).toBe(false);
  });
});

describe("A1 — PER ROOM, never global", () => {
  it("naming Home Office does NOT enable OPD 7 or Cardiology (F2)", () => {
    process.env[ROOM_DRAIN_ENV] = HOME_OFFICE;
    expect(isRoomDrainEnabled(HOME_OFFICE)).toBe(true);
    expect(isRoomDrainEnabled(OPD7)).toBe(false);
    expect(isRoomDrainEnabled(CARDIOLOGY)).toBe(false);
  });

  it("accepts comma and whitespace separators, and de-duplicates", () => {
    expect(parseRoomDrainFlag("a, b  c,,a").rooms).toEqual(["a", "b", "c"]);
  });

  for (const boolish of ["1", "true", "yes", "on", "*", "all", "always", "0", "false"]) {
    it(`"${boolish}" is REFUSED and enables nothing — it is not a wildcard`, () => {
      process.env[ROOM_DRAIN_ENV] = boolish;
      expect(isRoomDrainEnabled(HOME_OFFICE)).toBe(false);
      expect(isRoomDrainEnabled(OPD7)).toBe(false);
      const st = roomDrainFlagState();
      expect(st.misconfigured).toBe(true);
      expect(st.refused).toContain(boolish);
    });
  }

  it("a refused token beside a real room leaves the real room enabled and names the refusal", () => {
    process.env[ROOM_DRAIN_ENV] = `*, ${HOME_OFFICE}`;
    expect(isRoomDrainEnabled(HOME_OFFICE)).toBe(true);
    expect(isRoomDrainEnabled(OPD7)).toBe(false);
    expect(roomDrainFlagState().refused).toEqual(["*"]);
    expect(roomDrainFlagState().misconfigured).toBe(false);
  });
});

describe("A1 — read at the point of use, never cached", () => {
  it("a change to the env is visible on the very next call", () => {
    process.env[ROOM_DRAIN_ENV] = HOME_OFFICE;
    expect(isRoomDrainEnabled(HOME_OFFICE)).toBe(true);
    process.env[ROOM_DRAIN_ENV] = "";
    expect(isRoomDrainEnabled(HOME_OFFICE)).toBe(false);
    process.env[ROOM_DRAIN_ENV] = OPD7;
    expect(isRoomDrainEnabled(OPD7)).toBe(true);
    expect(isRoomDrainEnabled(HOME_OFFICE)).toBe(false);
  });

  it("the module holds no top-level read of the env", () => {
    const src = readFileSync("lib/stt/room-drain-flag.ts", "utf8");
    const body = src.slice(src.indexOf("export const ROOM_DRAIN_ENV"));
    // process.env may appear ONLY inside the two functions, never as a module-scope const.
    expect(body).not.toMatch(/^const\s+\w+\s*=\s*process\.env/m);
  });
});

/**
 * The hazard comment's promise, enforced. CCB_ENABLED's comment claims eight call sites and
 * guards eleven — which is what a hazard comment does when nothing checks it.
 */
describe("A1 — the hazard comment names EVERY call site", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (f === "node_modules" || f === ".next" || f === ".git") return [];
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
    });

  it("there are exactly FOUR, in the three files the comment names", () => {
    const sites = [...walk("lib"), ...walk("app")]
      .filter((f) => !f.endsWith("room-drain-flag.ts"))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .filter((l) => l.includes("isRoomDrainEnabled(") && !l.trimStart().startsWith("import"))
          .map(() => f),
      );
    expect(sites).toHaveLength(4);
    expect(sites.filter((f) => f.endsWith("lib/bench-window.ts"))).toHaveLength(1);
    expect(sites.filter((f) => f.endsWith("lib/stt/room-drain.ts"))).toHaveLength(2);
    // The fourth is a REPORT, not a guard — it answers the admin GET and gates no work.
    expect(sites.filter((f) => f.endsWith("app/api/admin/bench/drain/route.ts"))).toHaveLength(1);
  });
});
