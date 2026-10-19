import assert from "node:assert/strict";
import { test } from "node:test";
import { v3Enabled } from "../src/v3/hub.js";
import { caller, register, setup } from "./helpers.js";

/** Captured at the base commit with UBUS_V3 unset: the exact outputs of today's behaviour. */
const GOLDEN = "[\n  {\n    \"ok\": true,\n    \"handle\": \"fable\",\n    \"address\": \"agent://mini/cowork/cowork:fable\",\n    \"presence\": \"poll\",\n    \"unread\": 0,\n    \"inbox_cursor\": 0,\n    \"renamed\": false,\n    \"requested_handle\": \"fable\",\n    \"label_machine_mismatch\": false,\n    \"machine_verified\": true,\n    \"machine\": \"mini\",\n    \"session\": \"cowork:fable\",\n    \"client_version\": null,\n    \"outdated\": true,\n    \"min_client_version\": \"0.2.0\"\n  },\n  {\n    \"ok\": true,\n    \"handle\": \"worker\",\n    \"address\": \"agent://mini/claude-code/s:worker\",\n    \"presence\": \"live\",\n    \"unread\": 0,\n    \"inbox_cursor\": 0,\n    \"renamed\": false,\n    \"requested_handle\": \"worker\",\n    \"label_machine_mismatch\": false,\n    \"machine_verified\": true,\n    \"machine\": \"mini\",\n    \"session\": \"s:worker\",\n    \"client_version\": null,\n    \"outdated\": true,\n    \"min_client_version\": \"0.2.0\"\n  },\n  {\n    \"ok\": true,\n    \"id\": \"ubus:ULID\",\n    \"thread_id\": \"t-ULID\",\n    \"schema\": \"ubus.msg/2\",\n    \"delivery\": [\n      {\n        \"to\": \"worker\",\n        \"status\": \"stored\"\n      }\n    ]\n  },\n  {\n    \"ok\": false,\n    \"error\": \"secret_rejected\",\n    \"message\": \"message rejected by the PHI/secret filter\",\n    \"rule\": \"secret.openai\"\n  },\n  {\n    \"ok\": false,\n    \"error\": \"phi_rejected\",\n    \"message\": \"message rejected by the PHI/secret filter\",\n    \"rule\": \"phi.uhid_mrn\"\n  },\n  {\n    \"ok\": false,\n    \"error\": \"unknown_agent\",\n    \"to\": [\n      \"ghost\"\n    ]\n  },\n  {\n    \"ok\": false,\n    \"error\": \"unknown_agent\",\n    \"to\": [\n      \"cc-air-work-local\"\n    ]\n  },\n  {\n    \"ok\": true,\n    \"id\": \"ubus:ULID\",\n    \"thread_id\": \"t-ULID\",\n    \"schema\": \"ubus.msg/2\",\n    \"delivery\": [\n      {\n        \"to\": \"worker\",\n        \"status\": \"stored\"\n      }\n    ]\n  },\n  {\n    \"ok\": true,\n    \"messages\": [\n      {\n        \"id\": \"ubus:ULID\",\n        \"ts\": \"2026-10-11T08:00:00.000Z\",\n        \"thread_id\": \"t-ULID\",\n        \"reply_to\": null,\n        \"from\": {\n          \"handle\": \"fable\",\n          \"label\": \"[mini:fable]\",\n          \"machine\": \"mini\",\n          \"machine_verified\": true,\n          \"label_machine_mismatch\": false,\n          \"runtime\": \"cowork\",\n          \"via\": \"local\"\n        },\n        \"subject\": \"note\",\n        \"body\": \"count=1 path=~/dev/eta-lab/z.json\",\n        \"kind\": \"msg\",\n        \"corr\": null,\n        \"delivery_status\": \"stored\",\n        \"for_pane\": null,\n        \"read\": false,\n        \"acked\": false\n      },\n      {\n        \"id\": \"ubus:ULID\",\n        \"ts\": \"2026-10-11T08:00:00.000Z\",\n        \"thread_id\": \"t-ULID\",\n        \"reply_to\": null,\n        \"from\": {\n          \"handle\": \"fable\",\n          \"label\": \"[mini:fable]\",\n          \"machine\": \"mini\",\n          \"machine_verified\": true,\n          \"label_machine_mismatch\": false,\n          \"runtime\": \"cowork\",\n          \"via\": \"local\"\n        },\n        \"subject\": \"Human RAG plan for Encounter Buddy, see newcat T28b\",\n        \"body\": \"count=1 path=~/dev/eta-lab/rag.json\",\n        \"kind\": \"msg\",\n        \"corr\": null,\n        \"delivery_status\": \"stored\",\n        \"for_pane\": null,\n        \"read\": false,\n        \"acked\": false\n      }\n    ]\n  },\n  {\n    \"ok\": true,\n    \"messages\": [\n      {\n        \"id\": \"ubus:ULID\",\n        \"ts\": \"2026-10-11T08:00:00.000Z\",\n        \"thread_id\": \"t-ULID\",\n        \"reply_to\": null,\n        \"from\": {\n          \"handle\": \"fable\",\n          \"label\": \"[mini:fable]\",\n          \"machine\": \"mini\",\n          \"machine_verified\": true,\n          \"label_machine_mismatch\": false,\n          \"runtime\": \"cowork\",\n          \"via\": \"local\"\n        },\n        \"subject\": \"note\",\n        \"body\": \"count=1 path=~/dev/eta-lab/z.json\",\n        \"kind\": \"msg\",\n        \"corr\": null,\n        \"delivery_status\": \"stored\",\n        \"for_pane\": null,\n        \"read\": true,\n        \"acked\": false\n      },\n      {\n        \"id\": \"ubus:ULID\",\n        \"ts\": \"2026-10-11T08:00:00.000Z\",\n        \"thread_id\": \"t-ULID\",\n        \"reply_to\": null,\n        \"from\": {\n          \"handle\": \"fable\",\n          \"label\": \"[mini:fable]\",\n          \"machine\": \"mini\",\n          \"machine_verified\": true,\n          \"label_machine_mismatch\": false,\n          \"runtime\": \"cowork\",\n          \"via\": \"local\"\n        },\n        \"subject\": \"Human RAG plan for Encounter Buddy, see newcat T28b\",\n        \"body\": \"count=1 path=~/dev/eta-lab/rag.json\",\n        \"kind\": \"msg\",\n        \"corr\": null,\n        \"delivery_status\": \"stored\",\n        \"for_pane\": null,\n        \"read\": true,\n        \"acked\": false\n      }\n    ]\n  },\n  {\n    \"ok\": true,\n    \"acked\": [\n      \"ubus:ULID\"\n    ],\n    \"missing\": []\n  },\n  {\n    \"ok\": true,\n    \"registered\": true,\n    \"handle\": \"worker\",\n    \"address\": \"agent://mini/claude-code/s:worker\",\n    \"presence\": \"live\",\n    \"machine\": \"mini\",\n    \"machine_verified\": true,\n    \"runtime\": \"claude-code\",\n    \"owner\": \"fable\",\n    \"orchestrator\": \"fable\",\n    \"unread\": 0,\n    \"via\": \"local\",\n    \"platform_class\": \"\"\n  },\n  {\n    \"ok\": true,\n    \"agents\": [\n      {\n        \"handle\": \"fable\",\n        \"machine\": \"mini\",\n        \"runtime\": \"cowork\",\n        \"session\": \"cowork:fable\",\n        \"owner\": \"v\",\n        \"orchestrator\": \"fable\",\n        \"address\": \"agent://mini/cowork/cowork:fable\",\n        \"presence\": \"poll\",\n        \"discovered\": false,\n        \"client_version\": null,\n        \"machine_verified\": true,\n        \"label_machine_mismatch\": false,\n        \"last_heartbeat_at\": \"2026-10-11T08:00:00.000Z\",\n        \"last_turn_at\": \"\"\n      },\n      {\n        \"handle\": \"worker\",\n        \"machine\": \"mini\",\n        \"runtime\": \"claude-code\",\n        \"session\": \"s:worker\",\n        \"owner\": \"fable\",\n        \"orchestrator\": \"fable\",\n        \"address\": \"agent://mini/claude-code/s:worker\",\n        \"presence\": \"live\",\n        \"discovered\": false,\n        \"client_version\": null,\n        \"machine_verified\": true,\n        \"label_machine_mismatch\": false,\n        \"last_heartbeat_at\": \"2026-10-11T08:00:00.000Z\",\n        \"last_turn_at\": \"\"\n      }\n    ]\n  },\n  {\n    \"ok\": true,\n    \"matches\": [\n      {\n        \"handle\": \"worker\",\n        \"machine\": \"mini\",\n        \"runtime\": \"claude-code\",\n        \"session\": \"s:worker\",\n        \"owner\": \"fable\",\n        \"orchestrator\": \"fable\",\n        \"address\": \"agent://mini/claude-code/s:worker\",\n        \"presence\": \"live\",\n        \"discovered\": false,\n        \"client_version\": null,\n        \"machine_verified\": true,\n        \"label_machine_mismatch\": false,\n        \"last_heartbeat_at\": \"2026-10-11T08:00:00.000Z\",\n        \"last_turn_at\": \"\"\n      }\n    ]\n  }\n]";

function normalize(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[0-9A-HJKMNP-TV-Z]{26}/g, "ULID");
}

async function runScript(): Promise<unknown[]> {
  const rig = setup();
  const out: unknown[] = [];
  try {
    delete process.env.UBUS_V3;
    out.push(await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" }));
    out.push(await register(rig.ubus, "worker"));
    out.push(
      await rig.ubus.call(
        "ubus_send",
        { to: ["worker"], subject: "note", body: "count=1 path=~/dev/eta-lab/z.json" },
        caller("fable"),
      ),
    );
    out.push(
      await rig.ubus.call(
        "ubus_send",
        { to: ["worker"], subject: "creds", body: "token=sk-SUPERSECRETTOKENVALUE999999" },
        caller("fable"),
      ),
    );
    out.push(
      await rig.ubus.call(
        "ubus_send",
        { to: ["worker"], subject: "chart", body: "patient MRN: ABC12345 overnight" },
        caller("fable"),
      ),
    );
    out.push(await rig.ubus.call("ubus_send", { to: ["ghost"], subject: "x", body: "count=1 path=~/x" }, caller("fable")));
    out.push(
      await rig.ubus.call(
        "ubus_send",
        { to: ["cc-air-work-local"], subject: "via alias", body: "count=1 path=~/dev/eta-lab/alias.json" },
        caller("fable"),
      ),
    );
    out.push(
      await rig.ubus.call(
        "ubus_send",
        {
          to: ["worker"],
          subject: "Human RAG plan for Encounter Buddy, see newcat T28b",
          body: "count=1 path=~/dev/eta-lab/rag.json",
        },
        caller("fable"),
      ),
    );
    out.push(await rig.ubus.call("ubus_inbox", { peek: true }, caller("worker")));
    out.push(await rig.ubus.call("ubus_inbox", {}, caller("worker")));
    const inbox = out[out.length - 1] as { messages: Array<{ id: string }> };
    const mid = inbox.messages[0]!.id;
    out.push(await rig.ubus.call("ubus_ack", { ids: [mid] }, caller("worker")));
    out.push(await rig.ubus.call("ubus_whoami", {}, caller("worker")));
    out.push(await rig.ubus.call("ubus_directory", {}, caller("fable")));
    out.push(await rig.ubus.call("ubus_resolve", { name: "worker" }, caller("fable")));
    return out;
  } finally {
    rig.cleanup();
  }
}

test("flag off: the existing acceptance fixtures are byte-identical to the base behaviour", async () => {
  delete process.env.UBUS_V3;
  assert.equal(v3Enabled(), false);
  const out = await runScript();
  assert.equal(normalize(out), GOLDEN);
});

test("only UBUS_V3=1 turns the hub on", () => {
  delete process.env.UBUS_V3;
  assert.equal(v3Enabled(), false);
  process.env.UBUS_V3 = "0";
  assert.equal(v3Enabled(), false, "anything but 1 leaves the flag off");
  process.env.UBUS_V3 = "1";
  assert.equal(v3Enabled(), true);
  delete process.env.UBUS_V3;
  assert.equal(v3Enabled(), false);
});
