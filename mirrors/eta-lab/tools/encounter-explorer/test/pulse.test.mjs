import test from "node:test";
import assert from "node:assert/strict";
import { buildPulseLink } from "../src/pulse.js";

test("link needs both ids", () => {
  assert.equal(buildPulseLink("syn_rx_1", "syn_p1"), "https://pulse.even.in/prescription?prescription_uid=syn_rx_1&individual_uid=syn_p1");
  for (const [p, i] of [[null, "syn_p1"], ["syn_rx_1", null], [undefined, undefined], ["", "syn_p1"], ["syn_rx_1", "  "], [5, "x"]]) assert.equal(buildPulseLink(p, i), null);
});
test("ids are url-encoded", () => {
  assert.equal(buildPulseLink("a b&c", "d/e"), "https://pulse.even.in/prescription?prescription_uid=a%20b%26c&individual_uid=d%2Fe");
});
