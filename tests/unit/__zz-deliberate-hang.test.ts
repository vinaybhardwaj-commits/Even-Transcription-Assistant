// Deliberately hanging fixture to test yoga-ci-remote.sh's hard wall-clock timeout (23 Sep 2026).
// Never meant to be committed to the real repo — lives only in this throwaway test run.
import { describe, it } from "vitest";
describe("deliberate hang", () => {
  it("never returns", async () => {
    await new Promise(() => {}); // a promise that never resolves — vitest waits on it forever
  });
});
