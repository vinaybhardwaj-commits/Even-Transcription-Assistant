/**
 * tests/support/docker.ts — the ONE place the test harness spawns the docker CLI.
 *
 * V standing rule (14 Oct 2026): Docker and containerised suites never run on the Mac Mini (the pg harness drove its
 * load to 53). On the Mini no docker process is ever spawned: cleanup/listing (`rm`, `ps`) is a no-op returning "",
 * anything that would START or USE a container throws, so a suite can never fake a pass. No override.
 */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import os from "node:os";

export const MINI_DOCKER_MSG = "pg harness: Docker suites never run on the Mac Mini (V, 14 Oct); run on c3/Yoga/lab box";

export function isMiniHost(): boolean {
  return os.hostname().toLowerCase().replace(/\.local$/, "") === "vinays-mac-mini-3" || process.env.ETA_HOST_ROLE === "mini";
}

/** `execFileSync("docker", args, opts)`, except on the Mini (see above). Same return type as execFileSync. */
export function dockerCli(args: string[], opts?: ExecFileSyncOptions): string | Buffer {
  if (isMiniHost()) {
    if (args[0] === "rm" || args[0] === "ps") return "";
    throw new Error(MINI_DOCKER_MSG);
  }
  return execFileSync("docker", args, opts);
}
