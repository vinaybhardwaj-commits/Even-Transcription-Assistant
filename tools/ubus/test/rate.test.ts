import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR_MS } from "../src/constants.js";
import { defaultConfig, mergeConfig } from "../src/config.js";
import { caller, register, setup } from "./helpers.js";

async function send(rig: ReturnType<typeof setup>, from: string, n: number) {
  return rig.ubus.call("ubus_send", { to: ["fable"], subject: `s${n}`, body: `count=${n} path=~/a${n}` }, caller(from));
}

test("per-handle and per-machine send limits are independent", async () => {
  const rig = setup((cfg) => {
    cfg.limits.sendsPerHour = 2;
    cfg.limits.machineSendsPerHour = 6;
  });
  try {
    for (const h of ["fable", "a1", "a2", "a3"]) await register(rig.ubus, h);
    for (const h of ["a1", "a2", "a3"]) {
      assert.equal((await send(rig, h, 1)).ok, true);
      assert.equal((await send(rig, h, 2)).ok, true);
      if (h === "a1") assert.equal((await send(rig, h, 3)).error, "rate_limited");
    }
    // machine bucket now holds 6 sends (a1 x2, a2 x2, a3 x2); fable has own handle budget but machine is full
    assert.equal((await send(rig, "fable", 9)).error, "rate_limited");
    rig.clock.advance(HOUR_MS + 1);
    assert.equal((await send(rig, "fable", 10)).ok, true);
  } finally {
    rig.cleanup();
  }
});

test("handle override replaces per-handle limit only for that handle", async () => {
  const rig = setup((cfg) => {
    cfg.limits.sendsPerHour = 2;
    cfg.limits.handleSendsPerHour = { pager: 4 };
  });
  try {
    for (const h of ["fable", "pager", "other"]) await register(rig.ubus, h);
    for (let i = 0; i < 4; i++) assert.equal((await send(rig, "pager", i)).ok, true);
    assert.equal((await send(rig, "pager", 5)).error, "rate_limited");
    assert.equal((await send(rig, "other", 1)).ok, true);
    assert.equal((await send(rig, "other", 2)).ok, true);
    assert.equal((await send(rig, "other", 3)).error, "rate_limited");
  } finally {
    rig.cleanup();
  }
});

test("config parsing: new keys, defaults, bad values fall back", () => {
  const d = defaultConfig("/tmp/ubus-x");
  assert.equal(d.limits.sendsPerHour, 60);
  assert.equal(d.limits.machineSendsPerHour, 600);
  assert.deepEqual(d.limits.handleSendsPerHour, {});
  const ok = mergeConfig(defaultConfig("/tmp/ubus-x"), { limits: { sends_per_hour: 30, machine_sends_per_hour: 900, handle_sends_per_hour: { "room-guardian": 240 } } }, "/tmp/ubus-x");
  assert.equal(ok.limits.sendsPerHour, 30);
  assert.equal(ok.limits.machineSendsPerHour, 900);
  assert.deepEqual(ok.limits.handleSendsPerHour, { "room-guardian": 240 });
  const bad = mergeConfig(defaultConfig("/tmp/ubus-x"), { limits: { sends_per_hour: -1, machine_sends_per_hour: "x", handle_sends_per_hour: { a: 0, b: 1.5, c: "9", d: 7 } } }, "/tmp/ubus-x");
  assert.equal(bad.limits.sendsPerHour, 60);
  assert.equal(bad.limits.machineSendsPerHour, 600);
  assert.deepEqual(bad.limits.handleSendsPerHour, { d: 7 });
  const arr = mergeConfig(defaultConfig("/tmp/ubus-x"), { limits: { handle_sends_per_hour: [1] } }, "/tmp/ubus-x");
  assert.deepEqual(arr.limits.handleSendsPerHour, {});
});
