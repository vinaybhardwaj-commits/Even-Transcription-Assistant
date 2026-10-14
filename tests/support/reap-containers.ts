import { dockerCli } from "./docker";

/**
 * Containers this process started and has not yet removed. A test that fails, times out or is killed never
 * reaches its own `stop()`, and `--rm` only fires when the container's main process exits, so 65 postgres
 * containers (+97 anonymous volumes) piled up. `docker rm -fv` on exit/SIGINT/SIGTERM closes that gap.
 */
const live = new Set<string>();
let hooked = false;
function reap(): void {
  for (const n of live) { try { dockerCli(["rm", "-fv", n], { stdio: "ignore", timeout: 60_000 }); } catch { /* already gone */ } }
  live.clear();
}
export function removeOnExit(name: string): void {
  live.add(name);
  if (hooked) return;
  hooked = true;
  process.on("exit", reap);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { reap(); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[sig]); });
}
export function forgetOnExit(name: string): void { live.delete(name); }
