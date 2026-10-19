import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./helpers.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const installer = join(root, "install", "install-plists.sh");
const hubBin = join(root, "dist", "bin", "ubus-hub.js");
const provision = join(root, "scripts", "hub-provision-node.sh");

function runInstaller(envText: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "ubus-inst-"));
  const envfile = join(dir, "local.env");
  if (envText !== null) writeFileSync(envfile, envText);
  const res = spawnSync("sh", [installer], { env: { ...cleanEnv(), UBUS_LOCAL_ENV: envfile, UBUS_LAUNCHAGENTS_DIR: join(dir, "la") }, encoding: "utf8" });
  return { res, dir };
}

test("D1 installer refuses: missing file, unset, placeholder, bad characters", () => {
  for (const text of [null, "", "UBUS_MINI_HOST=\n", "UBUS_MINI_HOST=__UBUS_MINI_HOST__\n", "UBUS_MINI_HOST=a/b\n", "UBUS_MINI_HOST=a b\n", "UBUS_MINI_HOST=a;b\n"]) {
    const { res, dir } = runInstaller(text);
    assert.notEqual(res.status, 0, String(text));
    assert.match(res.stderr, /refused/);
    assert.equal(existsSync(join(dir, "la", "uk.llmvinayminihome.ubus-hub.plist")), false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D2 installer renders the hub plist with no placeholder left", () => {
  const { res, dir } = runInstaller("UBUS_MINI_HOST=fake-mini-host\n");
  assert.equal(res.status, 0, res.stderr);
  const plist = readFileSync(join(dir, "la", "uk.llmvinayminihome.ubus-hub.plist"), "utf8");
  assert.match(plist, /<string>fake-mini-host<\/string>/);
  assert.doesNotMatch(plist, /__UBUS_MINI_HOST__/);
  assert.match(plist, /<key>UBUS_V3<\/key>\s*<string>1<\/string>/);
  rmSync(dir, { recursive: true, force: true });
});

function hubEnv(dir: string, listen: string, v3: boolean): NodeJS.ProcessEnv {
  const cfg = join(dir, "hub.json");
  writeFileSync(cfg, JSON.stringify({ dbPath: join(dir, "e.db"), listen, keyDir: join(dir, "nodes"), laneOwnersPath: join(dir, "lo.json") }));
  const env: NodeJS.ProcessEnv = { ...cleanEnv(), UBUS_HUB_CONFIG: cfg, UBUS_V3_DB: join(dir, "e.db"), UBUS_V3_NAMEKEY: join(dir, "name.key") };
  if (v3) env.UBUS_V3 = "1";
  return env;
}

test("D3 ubus-hub refuses a wildcard listen and refuses without UBUS_V3", () => {
  for (const listen of ["0.0.0.0:0", "[::]:0", "0:0"]) {
    const dir = mkdtempSync(join(tmpdir(), "ubus-hubd-"));
    const r = spawnSync("node", [hubBin], { env: hubEnv(dir, listen, true), encoding: "utf8", timeout: 20000 });
    assert.equal(r.status, 1, `${listen} ${r.stdout}`);
    assert.match(r.stderr, /wildcard|IP literal/);
    rmSync(dir, { recursive: true, force: true });
  }
  const dir = mkdtempSync(join(tmpdir(), "ubus-hubd-"));
  const r = spawnSync("node", [hubBin], { env: hubEnv(dir, "127.0.0.1:0", false), encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /UBUS_V3/);
  rmSync(dir, { recursive: true, force: true });
});

test("D4 ubus-hub serves the health route on loopback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ubus-hubd-"));
  const child = spawn("node", ["--disable-warning=ExperimentalWarning", hubBin], { env: hubEnv(dir, "127.0.0.1:0", true) });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (c: Buffer) => {
        buf += c.toString();
        if (buf.includes("\n")) resolve(buf);
      });
      child.once("exit", () => reject(new Error("hub exited early")));
      setTimeout(() => reject(new Error("hub start timeout")), 15000);
    });
    const m = /listening on (127\.0\.0\.1):(\d+)/.exec(line);
    assert.ok(m, line);
    const r = await fetch(`http://${m[1]}:${m[2]}/api/v3/health`);
    assert.equal(r.status, 200);
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D5 hub-provision-node writes 0600 keys, prints no key, refuses overwrite and unknown nodes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ubus-prov-"));
  const cfg = join(dir, "hub.json");
  writeFileSync(cfg, JSON.stringify({ keyDir: join(dir, "nodes") }));
  const env = { ...cleanEnv(), UBUS_HUB_CONFIG: cfg };
  const out = join(dir, "asus.key.out");
  const r = spawnSync("sh", [provision, "asus", out], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const key = readFileSync(join(dir, "nodes", "asus.key"), "utf8").trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(r.stdout.includes(key), false);
  assert.equal(statSync(join(dir, "nodes", "asus.key")).mode & 0o777, 0o600);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(readFileSync(out, "utf8").trim(), key);
  assert.notEqual(spawnSync("sh", [provision, "asus", join(dir, "other")], { env, encoding: "utf8" }).status, 0);
  assert.notEqual(spawnSync("sh", [provision, "bogus", join(dir, "o2")], { env, encoding: "utf8" }).status, 0);
  rmSync(dir, { recursive: true, force: true });
});
