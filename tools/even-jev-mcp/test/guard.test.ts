import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoSecrets, assertWithinByteCap, JevGuardError, screenForSecrets } from "../src/guard/limits.js";

describe("guard: byte cap", () => {
  it("passes when the payload is exactly at the cap", () => {
    const payload = "x".repeat(10);
    const cap = Buffer.byteLength(JSON.stringify(payload));
    assert.doesNotThrow(() => assertWithinByteCap(payload, cap));
  });

  it("throws with the cap and measured size when one byte over", () => {
    const payload = "x".repeat(10);
    const cap = Buffer.byteLength(JSON.stringify(payload)) - 1;
    const measured = cap + 1;
    assert.throws(
      () => assertWithinByteCap(payload, cap),
      (error: unknown) =>
        error instanceof JevGuardError &&
        error.message.includes(String(cap)) &&
        error.message.includes(String(measured))
    );
  });
});

describe("guard: secret screening", () => {
  it("detects a PEM private key block", () => {
    assert.deepEqual(screenForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIB..."), [
      "private_key_block"
    ]);
  });

  it("detects an OpenAI-style key", () => {
    assert.deepEqual(screenForSecrets(`sk-${"a".repeat(20)}`), ["openai_style_key"]);
  });

  it("detects an AWS access key id", () => {
    assert.deepEqual(screenForSecrets("AKIA" + "ABCDEFGHIJKLMNOP"), ["aws_access_key_id"]);
  });

  it("detects a GitHub personal access token", () => {
    assert.deepEqual(screenForSecrets(`ghp_${"a".repeat(30)}`), ["github_personal_token"]);
  });

  it("detects a Slack token", () => {
    assert.deepEqual(screenForSecrets(`xoxb-${"a".repeat(10)}`), ["slack_token"]);
  });

  it("detects a Postgres connection string with embedded credentials", () => {
    assert.deepEqual(
      screenForSecrets("postgres://user:hunter2@db.internal:5432/app"),
      ["postgres_connection_string"]
    );
  });

  it("detects an env-style secret assignment line", () => {
    assert.deepEqual(
      screenForSecrets("some text\nDATABASE_PASSWORD=supersecretvalue\nmore text"),
      ["env_style_secret_assignment"]
    );
  });

  it("detects a Bearer token", () => {
    assert.deepEqual(screenForSecrets(`Bearer ${"a".repeat(24)}`), ["bearer_token"]);
  });

  it("finds no matches in ordinary text", () => {
    assert.deepEqual(screenForSecrets("just a normal diff with no secrets"), []);
  });

  it("fails closed: throws naming pattern names when secrets are present", () => {
    assert.throws(
      () => assertNoSecrets(["AKIA" + "ABCDEFGHIJKLMNOP"], false),
      (error: unknown) =>
        error instanceof JevGuardError && error.message.includes("aws_access_key_id")
    );
  });

  it("does not leak the matched content itself in the error", () => {
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    try {
      assertNoSecrets([secret], false);
      assert.fail("expected assertNoSecrets to throw");
    } catch (error) {
      assert.ok(error instanceof JevGuardError);
      assert.equal((error as Error).message.includes(secret), false);
    }
  });

  it("bypasses the check when JEV_ALLOW_SECRETS is set", () => {
    assert.doesNotThrow(() => assertNoSecrets(["AKIA" + "ABCDEFGHIJKLMNOP"], true));
  });
});
