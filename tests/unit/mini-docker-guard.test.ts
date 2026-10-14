/** V standing rule (14 Oct 2026): the pg harness never uses Docker on the Mac Mini. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({ host: "c3", exec: vi.fn() }));
vi.mock("node:os", () => ({ default: { hostname: () => H.host }, hostname: () => H.host }));
vi.mock("node:child_process", () => ({ execFileSync: H.exec }));

import { dockerAvailable as s1Docker } from "../support/s1-pg";
import { dockerAvailable as pgDocker } from "../support/pg-harness";

const MSG = "pg harness: Docker suites never run on the Mac Mini (V, 14 Oct); run on c3/Yoga/lab box";

describe.each([["s1-pg", s1Docker], ["pg-harness", pgDocker]])("mini docker guard: %s", (_n, fn) => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { H.exec.mockReset(); H.host = "c3"; delete process.env.ETA_HOST_ROLE; err = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { err.mockRestore(); delete process.env.ETA_HOST_ROLE; });

  it.each(["Vinays-Mac-Mini-3.local", "vinays-mac-mini-3"])("hostname %s -> false, docker never called", (h) => {
    H.host = h;
    expect(fn()).toBe(false);
    expect(H.exec).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(MSG);
  });

  it("ETA_HOST_ROLE=mini -> false, docker never called", () => {
    process.env.ETA_HOST_ROLE = "mini";
    expect(fn()).toBe(false);
    expect(H.exec).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(MSG);
  });

  it("another host -> unchanged: asks docker and returns true", () => {
    H.exec.mockReturnValue("");
    expect(fn()).toBe(true);
    expect(H.exec).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();
  });

  it("another host, docker absent -> false via the existing path", () => {
    H.exec.mockImplementation(() => { throw Object.assign(new Error("x"), { code: "ENOENT" }); });
    expect(fn()).toBe(false);
    expect(err).toHaveBeenCalledWith("dockerAvailable: docker CLI not found");
  });
});
