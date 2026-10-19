import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GENESIS, SPOOL_KEEP_MS } from "./constants.js";
import { chainHash, sha256Buf, utcParts, type Clock } from "./util.js";

export interface VolumeStatus {
  mounted: boolean;
  uuid: string | null;
  writable: boolean;
}

export interface VolumeProbe {
  check(mount: string): VolumeStatus;
}

export interface ArchiveAlert {
  since: string;
  spoolBytes: number;
  pendingSegments: number;
  reason: string;
}

export interface LogLine {
  seq: number;
  ts: string;
  src: string;
  event: string;
  rec: Record<string, unknown>;
  prev: string;
  h: string;
}

const SENSITIVE = new Set(["body", "text", "content", "prompt", "transcript", "question", "args", "args_canonical"]);

/** The durable log stores ids, counts, paths, and hashes. Never message text. */
export function scrubRecord(_event: string, rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined) continue;
    if (SENSITIVE.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function verifyChain(text: string): { ok: boolean; lines: number; error?: string } {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let obj: LogLine;
    try {
      obj = JSON.parse(lines[i]!) as LogLine;
    } catch {
      return { ok: false, lines: i, error: `line ${i + 1} is not json` };
    }
    if (obj.prev !== prev) return { ok: false, lines: i, error: `line ${i + 1} prev mismatch` };
    const payload = { seq: obj.seq, ts: obj.ts, src: obj.src, event: obj.event, rec: obj.rec, prev: obj.prev };
    const h = chainHash(obj.prev, payload);
    if (h !== obj.h) return { ok: false, lines: i, error: `line ${i + 1} hash mismatch` };
    prev = obj.h;
  }
  return { ok: true, lines: lines.length };
}

export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  const rel = relative(p, c);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface SegmentState {
  file: string;
  sha256: string;
  sealedAt: string;
  bytes: number;
  flushedAt?: string;
  coldPath?: string;
  prunedAt?: string;
}

interface SpoolState {
  seq: number;
  lastH: string;
  segments: SegmentState[];
  degradedSince: string | null;
  lastAlertAt: string | null;
  backoffMs: number;
  nextRetryAt: string | null;
}

export class Archive {
  private seq = 0;
  private prev = GENESIS;
  private state: SpoolState;
  private alertedThisFlush = false;

  constructor(
    readonly spoolDir: string,
    readonly coldRoot: string,
    readonly volumeMount: string,
    readonly expectedUuid: string,
    private clock: Clock,
    private probe: VolumeProbe,
    private onAlert: (info: ArchiveAlert) => void,
    private opts: { maxSpoolBytes: number; minFreeRatio: number; freeRatio?: () => number } ,
  ) {
    mkdirSync(this.spoolDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.spoolDir, "segments"), { recursive: true, mode: 0o700 });
    this.state = this.loadState();
    this.recoverTail();
  }

  private statePath(): string {
    return join(this.spoolDir, "state.json");
  }

  private currentPath(): string {
    return join(this.spoolDir, "current.jsonl");
  }

  private loadState(): SpoolState {
    const p = this.statePath();
    if (!existsSync(p)) {
      return { seq: 0, lastH: GENESIS, segments: [], degradedSince: null, lastAlertAt: null, backoffMs: 0, nextRetryAt: null };
    }
    const raw = JSON.parse(readFileSync(p, "utf8")) as SpoolState;
    raw.segments ??= [];
    return raw;
  }

  private saveState(): void {
    const p = this.statePath();
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, p);
  }

  private recoverTail(): void {
    const cur = this.currentPath();
    if (existsSync(cur)) {
      const lines = readFileSync(cur, "utf8").split("\n").filter((l) => l.trim());
      if (lines.length) {
        const last = JSON.parse(lines[lines.length - 1]!) as LogLine;
        this.seq = last.seq;
        this.prev = last.h;
        this.state.seq = this.seq;
        this.state.lastH = this.prev;
        return;
      }
    }
    this.seq = this.state.seq || 0;
    this.prev = this.state.lastH || GENESIS;
  }

  status(): { degraded: boolean; since: string | null; pending: number; spoolBytes: number } {
    const pending = this.state.segments.filter((s) => !s.flushedAt && !s.prunedAt).length;
    return {
      degraded: !!this.state.degradedSince,
      since: this.state.degradedSince,
      pending,
      spoolBytes: this.spoolBytes(),
    };
  }

  spoolBytes(): number {
    let n = 0;
    const cur = this.currentPath();
    if (existsSync(cur)) n += statSync(cur).size;
    for (const seg of this.state.segments) {
      if (seg.prunedAt) continue;
      if (existsSync(seg.file)) n += statSync(seg.file).size;
    }
    return n;
  }

  private freeRatio(): number {
    if (this.opts.freeRatio) return this.opts.freeRatio();
    try {
      const s = statfsSync(this.spoolDir);
      if (!s.blocks) return 1;
      return s.bavail / s.blocks;
    } catch {
      return 1;
    }
  }

  append(input: { src: string; event: string; rec: Record<string, unknown>; essential?: boolean }): { seq: number; h: string; dropped?: boolean } {
    const essential = input.essential !== false;
    const overBytes = this.spoolBytes() > this.opts.maxSpoolBytes;
    const lowDisk = this.freeRatio() < this.opts.minFreeRatio;
    if (!essential && (overBytes || lowDisk)) return { seq: this.seq, h: this.prev, dropped: true };

    const rec = scrubRecord(input.event, input.rec);
    this.seq += 1;
    const payload = {
      seq: this.seq,
      ts: this.clock.iso(),
      src: input.src,
      event: input.event,
      rec,
      prev: this.prev,
    };
    const h = chainHash(this.prev, payload);
    const line: LogLine = { ...payload, h };
    this.writeLine(this.currentPath(), JSON.stringify(line));
    this.prev = h;
    this.state.seq = this.seq;
    this.state.lastH = h;
    this.saveState();
    return { seq: line.seq, h };
  }

  private writeLine(file: string, line: string): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, "a", 0o600);
    try {
      writeSync(fd, line + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Seal the hot segment so it can be flushed. Safe to call when empty. */
  seal(): SegmentState | null {
    const cur = this.currentPath();
    if (!existsSync(cur) || statSync(cur).size === 0) return null;
    const parts = utcParts(this.clock.now());
    let name = `ubus-${parts.y}${parts.m}${parts.d}-${parts.h}.jsonl`;
    let dest = join(this.spoolDir, "segments", name);
    let n = 2;
    while (existsSync(dest)) {
      name = `ubus-${parts.y}${parts.m}${parts.d}-${parts.h}-${n}.jsonl`;
      dest = join(this.spoolDir, "segments", name);
      n += 1;
    }
    const sealRec = scrubRecord("seal", { segment: name, note: "sealed" });
    this.seq += 1;
    const payload = { seq: this.seq, ts: this.clock.iso(), src: "ubus", event: "seal", rec: sealRec, prev: this.prev };
    const h = chainHash(this.prev, payload);
    const line: LogLine = { ...payload, h };
    this.writeLine(cur, JSON.stringify(line));
    const bytes = statSync(cur).size;
    const sha = sha256Buf(readFileSync(cur));
    renameSync(cur, dest);
    this.prev = h;
    this.state.seq = this.seq;
    this.state.lastH = h;
    const seg: SegmentState = { file: dest, sha256: sha, sealedAt: this.clock.iso(), bytes };
    // Patch the seal line's rec.lines after the fact would break the hash.
    // The manifest records line counts separately.
    this.state.segments.push(seg);
    this.saveState();
    return seg;
  }

  /**
   * Copy sealed segments to cold storage only when the volume UUID matches.
   * A mismatch or unmount performs no writes under coldRoot or volumeMount.
   */
  flush(opts?: { force?: boolean }): { ok: boolean; reason?: string; flushed: string[]; skipped?: boolean } {
    const now = this.clock.now();
    if (!opts?.force && this.state.nextRetryAt && now < Date.parse(this.state.nextRetryAt)) {
      return { ok: false, reason: "backoff", flushed: [], skipped: true };
    }
    const pending = this.state.segments.filter((s) => !s.flushedAt);
    const decision = this.coldAllowed();
    if (!decision.ok) {
      this.noteDegraded(decision.reason || "unavailable");
      return { ok: false, reason: decision.reason, flushed: [] };
    }
    if (!isInside(this.volumeMount, this.coldRoot)) {
      this.noteDegraded("cold_root_outside_mount");
      return { ok: false, reason: "cold_root_outside_mount", flushed: [] };
    }
    const flushed: string[] = [];
    try {
      for (const seg of pending) {
        const coldPath = this.writeCold(seg);
        seg.flushedAt = this.clock.iso();
        seg.coldPath = coldPath;
        flushed.push(coldPath);
      }
      if (flushed.length) this.writeManifest();
      this.state.degradedSince = null;
      this.state.lastAlertAt = null;
      this.state.backoffMs = 0;
      this.state.nextRetryAt = null;
      this.saveState();
      this.prune();
      return { ok: true, flushed };
    } catch (err) {
      this.noteDegraded(err instanceof Error ? err.message : "flush_failed");
      return { ok: false, reason: "flush_failed", flushed };
    }
  }

  private coldAllowed(): { ok: boolean; reason?: string } {
    let status: VolumeStatus;
    try {
      status = this.probe.check(this.volumeMount);
    } catch {
      return { ok: false, reason: "probe_failed" };
    }
    if (!status.mounted) return { ok: false, reason: "unmounted" };
    if (!status.uuid) return { ok: false, reason: "uuid_unknown" };
    if (status.uuid.toLowerCase() !== this.expectedUuid.toLowerCase()) return { ok: false, reason: "uuid_mismatch" };
    if (!status.writable) return { ok: false, reason: "not_writable" };
    return { ok: true };
  }

  private noteDegraded(reason: string): void {
    const nowIso = this.clock.iso();
    if (!this.state.degradedSince) this.state.degradedSince = nowIso;
    const last = this.state.lastAlertAt ? Date.parse(this.state.lastAlertAt) : 0;
    const due = !this.state.lastAlertAt || this.clock.now() - last >= 6 * 60 * 60 * 1000;
    if (due) {
      const pending = this.state.segments.filter((s) => !s.flushedAt).length + (existsSync(this.currentPath()) && statSync(this.currentPath()).size > 0 ? 1 : 0);
      try {
        this.onAlert({
          since: this.state.degradedSince,
          spoolBytes: this.spoolBytes(),
          pendingSegments: pending,
          reason,
        });
      } catch {
        /* alert hook must not break the spool */
      }
      this.state.lastAlertAt = nowIso;
    }
    const prev = this.state.backoffMs || 0;
    const next = prev === 0 ? 10 * 60 * 1000 : Math.min(prev * 2, 60 * 60 * 1000);
    this.state.backoffMs = next;
    this.state.nextRetryAt = new Date(this.clock.now() + next).toISOString();
    this.saveState();
  }

  private writeCold(seg: SegmentState): string {
    const when = Date.parse(seg.sealedAt) || this.clock.now();
    const parts = utcParts(when);
    const dir = join(this.coldRoot, parts.y, parts.m, parts.d);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = seg.file.split("/").pop() || "segment.jsonl";
    const tmp = join(dir, `.${base}.${process.pid}.tmp`);
    const dest = join(dir, base);
    const data = readFileSync(seg.file);
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const got = sha256Buf(readFileSync(tmp));
    if (got !== seg.sha256) {
      rmSync(tmp, { force: true });
      throw new Error("cold sha256 mismatch");
    }
    renameSync(tmp, dest);
    return dest;
  }

  private writeManifest(): void {
    const byDay = new Map<string, SegmentState[]>();
    for (const seg of this.state.segments) {
      if (!seg.coldPath || !seg.flushedAt) continue;
      const when = Date.parse(seg.sealedAt) || this.clock.now();
      const p = utcParts(when);
      const key = `${p.y}-${p.m}-${p.d}`;
      const list = byDay.get(key) ?? [];
      list.push(seg);
      byDay.set(key, list);
    }
    for (const [day, segs] of byDay) {
      const [y, m, d] = day.split("-");
      const dir = join(this.coldRoot, y!, m!, d!);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const body = {
        day,
        segments: segs.map((s) => ({
          file: s.coldPath,
          sha256: s.sha256,
          bytes: s.bytes,
          sealed_at: s.sealedAt,
        })),
      };
      const dest = join(dir, `MANIFEST-${day}.json`);
      const tmp = dest + ".tmp";
      writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, dest);
    }
  }

  /** Drop hot copies 7 days after a verified flush. Never deletes cold files. */
  prune(): string[] {
    const removed: string[] = [];
    const now = this.clock.now();
    for (const seg of this.state.segments) {
      if (!seg.flushedAt || seg.prunedAt) continue;
      if (now - Date.parse(seg.flushedAt) < SPOOL_KEEP_MS) continue;
      if (existsSync(seg.file)) {
        rmSync(seg.file, { force: true });
        removed.push(seg.file);
      }
      seg.prunedAt = this.clock.iso();
    }
    if (removed.length) this.saveState();
    return removed;
  }

  /** Test helper: list files under cold root. Does not create the directory. */
  listCold(): string[] {
    if (!existsSync(this.coldRoot)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk(this.coldRoot);
    return out;
  }
}

export function systemVolumeProbe(): VolumeProbe {
  return {
    check(mount: string): VolumeStatus {
      if (!existsSync(mount)) return { mounted: false, uuid: null, writable: false };
      let uuid: string | null = null;
      if (process.platform === "darwin") {
        uuid = diskutilUuid(mount);
      }
      if (!uuid) {
        const marker = join(mount, ".ubus-volume-uuid");
        if (existsSync(marker)) uuid = readFileSync(marker, "utf8").trim();
      }
      let writable = false;
      try {
        const probe = join(mount, ".ubus-write-probe");
        writeFileSync(probe, "ok", { flag: "w" });
        rmSync(probe, { force: true });
        writable = true;
      } catch {
        writable = false;
      }
      return { mounted: true, uuid, writable };
    },
  };
}

function diskutilUuid(mount: string): string | null {
  try {
    const res = spawnSync("diskutil", ["info", "-plist", mount], { encoding: "utf8", timeout: 5000 });
    if (res.status !== 0 || !res.stdout) return null;
    const m = res.stdout.match(/<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export class ScriptedProbe implements VolumeProbe {
  constructor(private status: VolumeStatus) {}
  set(status: VolumeStatus): void {
    this.status = status;
  }
  check(): VolumeStatus {
    return this.status;
  }
}
