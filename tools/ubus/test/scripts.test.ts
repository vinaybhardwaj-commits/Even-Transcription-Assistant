import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./helpers.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const restart = join(root, "scripts", "restart-panes.sh");
const install = join(root, "scripts", "install-client.sh");

test("R2/B4 both scripts refuse denied hosts before any ssh, exit non-zero", () => {
  for (const host of ["icu", "ORB2", "vinay-orb2", "ehrc-kiosk-1", "vinay@ICU"]) {
    for (const script of [restart, install]) {
      // a fake ssh on PATH that would leave a marker if it were ever called
      const dir = mkdtempSync(join(tmpdir(), "ubus-deny-"));
      writeFileSync(join(dir, "ssh"), `#!/bin/sh\ntouch "${dir}/ssh-called"\nexit 1\n`);
      chmodSync(join(dir, "ssh"), 0o755);
      const res = spawnSync("bash", [script, host, "--dry-run"], { env: { ...cleanEnv(), PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
      assert.notEqual(res.status, 0, `${script} ${host}`);
      assert.match(res.stderr, /denied machine/);
      assert.equal(spawnSync("test", ["-e", join(dir, "ssh-called")]).status, 1, "ssh was called");
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function fixture(): { dir: string; env: NodeJS.ProcessEnv; claudes: Array<ReturnType<typeof spawn>> } {
  const dir = mkdtempSync(join(tmpdir(), "ubus-rp-"));
  const lists: Record<string, unknown[]> = {
    A: [{ name: "a-self", pane_id: "w1:p1", agent: "claude", agent_status: "idle", cwd: "/x", agent_session: { value: "sid-a" } }],
    B: [
      { name: "b-one", pane_id: "w1:p1", agent: "claude", agent_status: "idle", cwd: "/x", agent_session: { value: "sid-b1" } },
      { name: "b-nomodel", pane_id: "w2:p1", agent: "claude", agent_status: "idle", cwd: "/x", agent_session: { value: "sid-b2" } },
      { name: "b-shell", pane_id: "w3:p1", agent: "codex", agent_status: "idle", cwd: "/x" },
    ],
  };
  writeFileSync(
    join(dir, "herdr"),
    `#!/bin/sh
if [ "$1" = session ]; then printf 'name status directory socket\\nA running /a /a/s\\nB running /b /b/s\\n'; exit 0; fi
if [ "$1" != "--session" ]; then echo "herdr called without --session" >&2; exit 9; fi
case "$2 $3 $4" in
  "A agent list") echo '${JSON.stringify({ result: { agents: lists.A } })}' ;;
  "B agent list") echo '${JSON.stringify({ result: { agents: lists.B } })}' ;;
esac
`,
  );
  chmodSync(join(dir, "herdr"), 0o755);
  writeFileSync(join(dir, "claude"), "#!/bin/sh\nsleep 20\n");
  chmodSync(join(dir, "claude"), 0o755);
  const claudes = [
    spawn(join(dir, "claude"), ["--resume", "sid-a", "-n", "a-self", "--model", "m1", "--permission-mode", "auto"], { stdio: "ignore" }),
    spawn(join(dir, "claude"), ["--resume", "sid-b1", "-n", "b-one", "--model", "m1", "--permission-mode", "auto"], { stdio: "ignore" }),
    spawn(join(dir, "claude"), ["--resume", "sid-b2", "-n", "b-nomodel"], { stdio: "ignore" }),
  ];
  const env = { ...cleanEnv(), PATH: `${dir}:${process.env.PATH}`, HERDR_SESSION: "A", HERDR_PANE_ID: "w1:p1" };
  return { dir, env, claudes };
}

async function run(env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  await new Promise((r) => setTimeout(r, 400)); // let the fake claude processes appear in ps
  const res = spawnSync("bash", [restart, "local", ...args, "--dry-run"], { env, encoding: "utf8" });
  return res.stdout + res.stderr;
}

test("R2/B1+B3 from a pane in session A, listing B shows B's panes only; the caller's own pane is skipped; no model/mode is skipped", async () => {
  const f = fixture();
  try {
    const outB = await run(f.env, ["--session", "B"]);
    assert.match(outB, /DRY-RUN B\/b-one .*--resume sid-b1 -n b-one --model m1 --permission-mode auto/);
    assert.doesNotMatch(outB, /a-self/);
    assert.match(outB, /SKIP\s+B\/b-nomodel\s+no model\/mode/);
    assert.match(outB, /SKIP\s+B\/b-shell\s+not a claude coding agent/);
    assert.doesNotMatch(outB, /--model\s+--|--model ""/);
    const outA = await run(f.env, ["--session", "A"]);
    assert.match(outA, /SKIP\s+A\/a-self\s+this script is running in this pane/);
    assert.doesNotMatch(outA, /DRY-RUN A\/a-self/);
    // the same pane id in B is a different pane: not skipped
    const all = await run(f.env, []);
    assert.match(all, /SKIP\s+A\/a-self/);
    assert.match(all, /DRY-RUN B\/b-one/);
    // the caller's session derives from the socket path when HERDR_SESSION is unset
    const env2 = { ...f.env, HERDR_SESSION: "", HERDR_SOCKET_PATH: "/home/u/.config/herdr/sessions/A/herdr.sock" };
    assert.match(await run(env2, ["--session", "A"]), /SKIP\s+A\/a-self\s+this script is running/);
    // --only filters
    const only = await run(f.env, ["--session", "B", "--only", "b-one"]);
    assert.match(only, /1 herdr agent pane/);
  } finally {
    for (const c of f.claudes) c.kill("SIGKILL");
    rmSync(f.dir, { recursive: true, force: true });
  }
});
