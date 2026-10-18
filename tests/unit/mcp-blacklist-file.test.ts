/** The private blacklist file loader (R4): mode, owner, shape, exact addresses. No database. */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readBlacklistFile } from "@/lib/mcp/blacklist-file";

const dir = mkdtempSync(`${tmpdir()}/blf-`);
const file = (content: string, mode = 0o600) => { const p = `${dir}/f${Math.random().toString(36).slice(2)}.json`; writeFileSync(p, content); chmodSync(p, mode); return p; };

describe("readBlacklistFile", () => {
  it("reads exact lowercase addresses from a 0600 file, array or {emails}", () => {
    expect(readBlacklistFile(file(JSON.stringify(["a.b@example.test", "c.d@example.test", "a.b@example.test"])))).toEqual(["a.b@example.test", "c.d@example.test"]);
    expect(readBlacklistFile(file(JSON.stringify({ emails: ["a.b@example.test"] })))).toEqual(["a.b@example.test"]);
  });
  it("refuses with a closed code (never the content): no env, missing, group/world readable, not json, empty, not an address, not already lowercase, padded", () => {
    expect(() => readBlacklistFile(undefined)).toThrow("blacklist_file_env_unset");
    expect(() => readBlacklistFile(`${dir}/nope.json`)).toThrow("blacklist_file_unreadable");
    expect(() => readBlacklistFile(file(JSON.stringify(["a@example.test"]), 0o644))).toThrow("blacklist_file_mode_not_0600");
    expect(() => readBlacklistFile(file(JSON.stringify(["a@example.test"]), 0o640))).toThrow("blacklist_file_mode_not_0600");
    expect(() => readBlacklistFile(file("not json"))).toThrow("blacklist_file_not_json");
    expect(() => readBlacklistFile(file("[]"))).toThrow("blacklist_file_bad_list");
    expect(() => readBlacklistFile(file(JSON.stringify(["not-an-address"])))).toThrow("blacklist_file_bad_address");
    expect(() => readBlacklistFile(file(JSON.stringify(["Mixed@example.test"])))).toThrow("blacklist_file_bad_address");
    expect(() => readBlacklistFile(file(JSON.stringify([" a@example.test"])))).toThrow("blacklist_file_bad_address");
    expect(() => readBlacklistFile(file(JSON.stringify(["a*@example.test"])))).toThrow("blacklist_file_bad_address"); // no wildcard, no pattern
  });
});
