import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { newId } from '../../../ids.js'
import type { JudgeQuestionSet } from '../../../platform/agent/judge-port.js'
import { candidatesOf, type AgentDefinition, type GatedFact } from '../../../platform/agent/types.js'
import type { ConsultAuditInput } from '../input.js'
import { prepass } from '../prepass.js'
import { segmentId } from '../segments.js'
import type { JudgePairRecord } from './report.js'

/**
 * Bench export (S6-Rf, Fable R3): one line per judged candidate with the claim and window the judges received, so a labeler's
 * input can be rebuilt from the line plus the input JSONL turns. The file carries quotes: it stays on t4 and is never logged,
 * never in report.md, never in the bus-safe block. Opt-in with --bench-out; the run refuses an existing path.
 */

export const BENCH_FILE_MODE = 0o600

export interface BenchSegment {
  segment_id: string
  t0: number | null
  t1: number | null
}

export interface BenchFact extends BenchSegment {
  role: string
  quote: string
}

export interface BenchLine {
  bench_id: string
  encounter_id: string
  rule_id: string
  polarity: 'presence' | 'absence'
  question_set: string
  /** The exact claim in the state both judges received. */
  claim: string
  /** The whole-segment context both judges received (absence rules), in order; empty for presence rules. */
  context: BenchSegment[]
  /** Local labels f1..fn, aligned with `facts` (the platform's fact ids are hashes and are not exported). */
  fact_refs: string[]
  /** The evidence facts of the candidate, in the order the judges saw their quotes. */
  facts: BenchFact[]
  primary_p: number | null
  second_p: number | null
  outcome: JudgePairRecord['outcome']
}

/** A uuid with no run of 8 or more digits, so the id passes the bus-safe digit check even if it is ever quoted. */
export function benchId(): string {
  for (;;) {
    const id = newId()
    if (!/\d{8,}/.test(id)) return id
  }
}

interface SeenCandidate {
  rule_id: string
  summary: string
  factRefs: string[]
  used: boolean
}

interface JudgeState {
  rule?: unknown
  claim?: unknown
  evidence?: Array<{ quote?: unknown }>
  context_segments?: Array<{ segment_id?: unknown }>
}

/** One per consult. Wraps the rules to see each candidate's fact refs, then pairs them with the judge asks. */
export class BenchRecorder {
  private readonly seen: SeenCandidate[] = []
  private readonly facts = new Map<string, GatedFact<unknown>>()
  private readonly times = new Map<string, BenchSegment>()
  private readonly asks: Array<{ state: JudgeState; set: JudgeQuestionSet; polarity: 'presence' | 'absence'; pair: JudgePairRecord; candidate: SeenCandidate | null }> = []
  unmatched = 0

  constructor(private readonly input: ConsultAuditInput) {
    const pass = prepass(input)
    pass.turns.forEach((turn, i) => this.times.set(segmentId(i), { segment_id: segmentId(i), t0: turn.t0, t1: turn.t1 }))
  }

  /** The definition with each rule's evaluate observed (same output, same order). */
  wrap<I, F, C>(def: AgentDefinition<I, F, C>): AgentDefinition<I, F, C> {
    return {
      ...def,
      rules: def.rules.map((rule) => ({
        ...rule,
        evaluate: (facts: GatedFact<F>[], ctx?: C) => {
          const out = rule.evaluate(facts, ctx)
          for (const f of facts) this.facts.set(f.id, f as GatedFact<unknown>)
          for (const c of candidatesOf(out)) this.seen.push({ rule_id: rule.id, summary: c.summary, factRefs: [...c.factRefs].sort(), used: false })
          return out
        },
      })),
    }
  }

  /** Called with the state the judges are asked about, before the answer. `pair` is mutated by the metered judge later. */
  begin(state: unknown, set: JudgeQuestionSet, polarity: 'presence' | 'absence', pair: JudgePairRecord): void {
    const s = state as JudgeState
    const quotes = (s.evidence ?? []).map((e) => e.quote)
    const candidate =
      this.seen.find(
        (c) =>
          !c.used &&
          c.rule_id === s.rule &&
          c.summary === s.claim &&
          c.factRefs.length === quotes.length &&
          c.factRefs.every((ref, i) => this.facts.get(ref)?.quote === quotes[i]),
      ) ?? null
    if (candidate) candidate.used = true
    else this.unmatched += 1
    this.asks.push({ state: s, set, polarity, pair, candidate })
  }

  /** Lines for every judged candidate, read after the run so the pair fields are final. */
  lines(): BenchLine[] {
    return this.asks.map(({ state, set, polarity, pair, candidate }) => {
      const facts: BenchFact[] = (candidate?.factRefs ?? []).flatMap((ref) => {
        const f = this.facts.get(ref)
        return f ? [{ segment_id: f.segment_id, role: f.role, t0: f.t0, t1: f.t1, quote: f.quote }] : []
      })
      return {
        bench_id: benchId(),
        encounter_id: this.input.encounter_id,
        rule_id: pair.rule_id,
        polarity,
        question_set: set.id,
        claim: String(state.claim ?? ''),
        context: (state.context_segments ?? []).map((c) => this.times.get(String(c.segment_id)) ?? { segment_id: String(c.segment_id), t0: null, t1: null }),
        fact_refs: facts.map((_, i) => `f${i + 1}`),
        facts,
        primary_p: pair.primary_p,
        second_p: pair.second_p,
        outcome: pair.outcome,
      }
    })
  }
}

/** Creates the bench file (0600, empty). An existing path is refused, so a bench is never mixed or overwritten. */
export function prepareBenchFile(file: string): void {
  if (existsSync(file)) throw new Error('bench_path_exists')
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  writeFileSync(file, '', { mode: BENCH_FILE_MODE, flag: 'wx' })
}

export function appendBench(file: string, lines: BenchLine[]): void {
  for (const line of lines) appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: BENCH_FILE_MODE })
}
