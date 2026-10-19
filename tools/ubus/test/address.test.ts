import assert from "node:assert/strict";
import { test } from "node:test";
import { shortMachine } from "../src/address.js";

const SUFFIX = ".tail000000.ts.net";

test("shortMachine strips a generic tailnet suffix and maps the configured Mini host", () => {
  const prev = process.env.UBUS_MINI_HOST;
  try {
    process.env.UBUS_MINI_HOST = "fake-mini-host";
    assert.equal(shortMachine(`fake-mini-host${SUFFIX}`), "mini");
    assert.equal(shortMachine(`FAKE-MINI-HOST${SUFFIX}.`), "mini");
    assert.equal(shortMachine("fake-mini-host"), "mini");
    assert.equal(shortMachine(`some-box${SUFFIX}`), "some-box");
    process.env.UBUS_MINI_HOST = `fake-mini-host${SUFFIX}`;
    assert.equal(shortMachine("fake-mini-host"), "mini");
    delete process.env.UBUS_MINI_HOST;
    assert.equal(shortMachine(`fake-mini-host${SUFFIX}`), "fake-mini-host");
  } finally {
    if (prev === undefined) delete process.env.UBUS_MINI_HOST;
    else process.env.UBUS_MINI_HOST = prev;
  }
});
