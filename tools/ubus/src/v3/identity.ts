import { validHandle } from "../address.js";
import type { EventLog, EventRow } from "./eventlog.js";

export const SEED_ID = "fable";
export const SEED_ALIASES = ["cc-air-work-local"];

export interface AgentIdentity {
  id: string;
  aliases: string[];
}

export type RegisterResult =
  | { ok: true; id: string; aliases: string[] }
  | { ok: false; reason: "alias_collision"; conflict: { name: string; held_by: string } }
  | { ok: false; reason: "invalid"; message: string };

/**
 * Canonical agent ids and their aliases. Ids and aliases share one namespace
 * and are canonicalized to lower case: `Fable` next to `fable` is a collision,
 * not a second identity. Registering any name an existing id or alias already
 * holds (in any case) is refused with reason `alias_collision`. A send to an
 * alias resolves to the canonical id.
 */
export class Identity {
  private agents = new Map<string, AgentIdentity>();
  private aliasOf = new Map<string, string>();

  constructor(
    private log: EventLog,
    private now: () => string,
  ) {}

  /** Names are compared and stored in one case form. */
  private key(name: string): string {
    return name.trim().toLowerCase();
  }

  /** Fold one event into the identity views. */
  apply(event: EventRow): void {
    if (event.kind !== "agent.registered") return;
    const id = this.key(event.subjectId);
    const aliases = (Array.isArray(event.meta.aliases) ? event.meta.aliases.map(String) : []).map((a) => this.key(a));
    this.agents.set(id, { id, aliases });
    for (const alias of aliases) this.aliasOf.set(alias, id);
  }

  /** Rebuild the views from the log, oldest event first. */
  rebuild(): void {
    this.agents.clear();
    this.aliasOf.clear();
    for (const event of this.log.all()) this.apply(event);
  }

  resolve(name: string): string | undefined {
    if (!name) return undefined;
    const k = this.key(name);
    if (this.agents.has(k)) return k;
    return this.aliasOf.get(k);
  }

  get(id: string): AgentIdentity | undefined {
    return this.agents.get(id);
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  ids(): string[] {
    return [...this.agents.keys()].sort();
  }

  /** Every name in the shared namespace: canonical ids and aliases. */
  names(): string[] {
    return [...new Set([...this.agents.keys(), ...this.aliasOf.keys()])].sort();
  }

  register(id: string, aliases: string[] = []): RegisterResult {
    const clean = this.key(id);
    if (!clean || !validHandle(clean)) return { ok: false, reason: "invalid", message: "id is not a valid handle" };
    const cleanAliases: string[] = [];
    for (const raw of aliases) {
      const alias = this.key(String(raw));
      if (!alias || !validHandle(alias)) return { ok: false, reason: "invalid", message: "alias is not a valid handle" };
      if (cleanAliases.includes(alias) || alias === clean) return { ok: false, reason: "alias_collision", conflict: { name: alias, held_by: clean } };
      cleanAliases.push(alias);
    }
    const wanted = [clean, ...cleanAliases];
    for (const name of wanted) {
      const held = this.resolve(name);
      if (held) return { ok: false, reason: "alias_collision", conflict: { name, held_by: held } };
    }
    const ts = this.now();
    this.log.append({
      ts,
      actor: clean,
      kind: "agent.registered",
      subjectId: clean,
      meta: { aliases: cleanAliases },
    });
    this.apply({ id: 0, ts, actor: clean, kind: "agent.registered", subjectId: clean, bodyRef: null, meta: { aliases: cleanAliases } });
    return { ok: true, id: clean, aliases: cleanAliases };
  }

  /** Sorted, JSON-safe views for replay comparison. */
  snapshot(): { agents: AgentIdentity[]; alias_of: Array<[string, string]> } {
    return {
      agents: this.ids().map((id) => ({ id, aliases: [...(this.agents.get(id)?.aliases ?? [])] })),
      alias_of: [...this.aliasOf.entries()].map(([alias, id]) => [alias, id] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    };
  }
}
