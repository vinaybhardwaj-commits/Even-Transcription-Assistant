import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ADDRESS = fileURLToPath(new URL("../src/address.js", import.meta.url));
const DERIVE = fileURLToPath(new URL("../src/derive.js", import.meta.url));

type Env = Record<string, string>;
const run = (env: Env, code: string) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", `import { shortMachine as s } from ${JSON.stringify(ADDRESS)}; ${code}`], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
const out = (env: Env, hosts: string[]) => {
  const r = run(env, `console.log(JSON.stringify(${JSON.stringify(hosts)}.map(s)))`);
  return { v: JSON.parse(r.stdout) as string[], err: r.stderr };
};

test("A1 any hex tailnet id is stripped (not only 000000)", () => {
  const { v } = out({ UBUS_MINI_HOST: "boxm" }, ["boxm.tail1a2b3c.ts.net", "boxm.tailffffff.ts.net.", "boxm.tailabcdef.ts.net"]);
  assert.deepEqual(v, ["mini", "mini", "mini"]);
});
test("A1b hex-letter-only suffix is stripped for non-Mini hosts too", () => {
  assert.deepEqual(out({}, ["box.tailabcdef.ts.net", "box.tailfedcba.ts.net."]).v, ["box", "box"]);
});
test("A2 env value is case/space/suffix normalised", () => {
  assert.deepEqual(out({ UBUS_MINI_HOST: "  BoxM.TAIL9f9f9f.ts.net. " }, ["boxm"]).v, ["mini"]);
});
test("A3 unset: warns exactly once per process, mapping off", () => {
  const r = out({}, ["boxm.tail1a2b3c.ts.net", "x", "y"]);
  assert.deepEqual(r.v, ["boxm", "x", "y"]);
  assert.equal(r.err.split("\n").filter((l) => l.includes("UBUS_MINI_HOST")).length, 1);
});
test("A4 set: no warning", () => {
  assert.equal(out({ UBUS_MINI_HOST: "boxm" }, ["a"]).err, "");
});
test("A5 non-tailnet suffix not stripped into a Mini match", () => {
  assert.deepEqual(out({ UBUS_MINI_HOST: "boxm" }, ["boxm.example.com", "boxm.tail1a2b3c.ts.net.evil.com", "xboxm"]).v, ["boxm", "boxm", "xboxm"]);
});
test("A6 opd-bot map and plain hosts unchanged; no built-in Air mapping", () => {
  assert.deepEqual(out({}, ["fake-air-host.tail1a2b3c.ts.net", "opd-bot-1", "eta-lab-t4", "MINI", "c3.local."]).v, ["fake-air-host", "opd-bot", "eta-lab-t4", "mini", "c3"]);
});
test("A6b UBUS_HOST_MAP maps hosts; invalid JSON is ignored", () => {
  assert.deepEqual(out({ UBUS_HOST_MAP: '{"Fake-Air-Host":"air"}' }, ["fake-air-host.tail1a2b3c.ts.net", "other"]).v, ["air", "other"]);
  assert.deepEqual(out({ UBUS_HOST_MAP: "{nope" }, ["fake-air-host"]).v, ["fake-air-host"]);
  assert.deepEqual(out({ UBUS_HOST_MAP: "[1]" }, ["fake-air-host"]).v, ["fake-air-host"]);
});
test("A7 UBUS_MACHINE short-circuits derive: no warning", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as d from ${JSON.stringify(DERIVE)}; console.log(Object.keys(d).join(","))`], {
    env: { PATH: process.env.PATH ?? "", UBUS_MACHINE: "t4" },
    encoding: "utf8",
  });
  assert.equal(r.stderr.includes("UBUS_MINI_HOST"), false, r.stderr);
});
