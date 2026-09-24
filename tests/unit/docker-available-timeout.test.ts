// Pins the D1 fix (eta-refuter-2, 23 Sep; N1 in ETA-Refuter's 24 Sep verdict): dockerAvailable() must
// give up on a hung docker socket after 15 s and say why. Before it had no timeout, a sick daemon stalled
// the gate to the 1800 s watchdog -- and deleting `timeout: 15_000` is type-clean, so nothing else catches
// that. Fake `docker` binaries on PATH: no daemon is contacted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable as fromS1Pg } from "../support/s1-pg";
import { dockerAvailable as fromPgHarness } from "../support/pg-harness";

const REAL_PATH = process.env.PATH;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fake-docker-")); });
afterEach(() => { process.env.PATH = REAL_PATH; rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

function fakeDocker(script: string | null): void {
  if (script !== null) { writeFileSync(join(dir, "docker"), `#!/bin/sh\n${script}\n`); chmodSync(join(dir, "docker"), 0o755); }
  process.env.PATH = dir; // only the fake dir: no real docker can be reached
}

for (const [name, probe] of [["s1-pg", fromS1Pg], ["pg-harness", fromPgHarness]] as const) {
  describe(`dockerAvailable (${name})`, () => {
    it("CLI absent -> false, says so", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      fakeDocker(null);
      expect(probe()).toBe(false);
      expect(String(err.mock.calls[0]?.[0])).toContain("docker CLI not found");
    });

    it("daemon down -> false, carries stderr", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      fakeDocker('echo "Cannot connect to the Docker daemon" >&2; exit 1');
      expect(probe()).toBe(false);
      expect(String(err.mock.calls[0]?.[0])).toContain("server unreachable: Cannot connect to the Docker daemon");
    });

    it("healthy daemon -> true", () => {
      fakeDocker("echo 27.0.0");
      expect(probe()).toBe(true);
    });

    it("hung socket -> false in about 15 s, says it did not answer (NOT true after the full hang)", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      fakeDocker("/bin/sleep 40");
      const t0 = Date.now();
      const r = probe();
      const dt = Date.now() - t0;
      expect(r).toBe(false);
      expect(dt).toBeGreaterThanOrEqual(14_000);
      expect(dt).toBeLessThan(25_000);
      expect(String(err.mock.calls[0]?.[0])).toContain("did not answer within 15s");
    }, 45_000);

    it("a docker that dies of SIGTERM by itself is NOT mislabelled as a timeout", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      fakeDocker("kill -TERM $$");
      expect(probe()).toBe(false);
      expect(String(err.mock.calls[0]?.[0])).not.toContain("did not answer within 15s");
    });
  });
}
