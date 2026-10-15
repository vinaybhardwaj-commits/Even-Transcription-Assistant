// Wiring. ADAPTER ("current" | "catalog" | "mockup") and FIXTURE_DATA are build-time constants (see build.mjs); the adapter switch is the `impl` line below.
import { createAdapter } from "./adapter.js";
import { createCurrentImpl, createNotes } from "./adapter-current.js";
import { createFixtureImpl } from "./adapter-fixture.js";
import { createCatalogImpl } from "./adapter-catalog.js";
import { mountApp } from "./ui.js";

async function boot() {
  const use = async name => { try { return window.claude && typeof window.claude.use === "function" ? (await window.claude.use(name)) || null : null; } catch { return null; } };
  // the mockup declares no mcp capability, so it never asks for one
  const [mcp, sample, db, user] = await Promise.all(["mcp", "sample", "db", "user"].map(n => (n === "mcp" && ADAPTER === "mockup" ? null : use(n))));
  const userId = user ? () => user.id() : null;
  const impl = ADAPTER === "mockup" ? createFixtureImpl(FIXTURE_DATA) : ADAPTER === "catalog" ? createCatalogImpl({ mcp }) : createCurrentImpl({ mcp, db, userId });   // <- the one-line adapter switch (M2: createCatalogImpl)
  impl.notes = createNotes(db, userId);
  mountApp(document.getElementById("app"), { adapter: createAdapter(impl), adapterName: ADAPTER, caps: { mcp, sample, db, user } });
}
boot();
