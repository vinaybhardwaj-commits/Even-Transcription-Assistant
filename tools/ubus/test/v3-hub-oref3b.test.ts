import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { alerts, cleanupAfter, ev, rig, up } from "./v3-hub-helpers.js";
cleanupAfter();
test("Y8 a non-hub agent sending thread alert-<source id> to the owner must not suppress the owed alert", async () => {
  const r = rig(); let h = await up(r);
  try {
    writeFileSync(r.cfg.laneOwnersPath, "{broken");
    await h.post([ev(1, { state: "errored", reason: "auth" })]);
    const src = h.srv.hub.log.all().find((x) => x.kind === "hub.ev.agent.state")!.id;
    h.srv.hub.register("mallory"); if (!h.srv.hub.identity.resolve("newcat-orch")) h.srv.hub.register("newcat-orch");
    const s = h.srv.hub.send({ to: "newcat-orch", thread_id: `alert-${src}`, subject: "x", body: "y" }, { handle: "mallory", machine: "mini", machineVerified: true, via: "local" } as any);
    assert.ok((s as any).ok, JSON.stringify(s));
    writeFileSync(r.cfg.laneOwnersPath, JSON.stringify({ "bc-s6": "newcat-orch" }));
    await h.srv.close(); h = await up(r);
    assert.equal(alerts(h).length, 1);
  } finally { await h.srv.close(); }
});
