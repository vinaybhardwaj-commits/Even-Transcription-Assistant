import { execFileSync } from 'node:child_process'
import { jevConfig, loadEnv } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { openDatabase } from '../src/db/open.js'
import { HttpJevTransport } from '../src/decide/transport.js'
import { setBudgetMax } from '../src/llm/ledger.js'
import { askChoice, askNoul, askScore, type AskContext } from '../src/platform/jev/asks.js'
import { JEV_REVIEW_SET } from '../src/platform/jev/registry.js'

// usage: tsx scripts/jev-review.ts --base <sha> --head <sha> [--task <text>]
const MAX_DIFF_CHARS = 200_000

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

const base = flag('--base')
const head = flag('--head')
const REF = /^[0-9a-zA-Z._/][0-9a-zA-Z._/-]*$/ // no leading '-': a ref must never read as a git option
if (!base || !head || !REF.test(base) || !REF.test(head)) {
  process.stderr.write('usage: tsx scripts/jev-review.ts --base <sha> --head <sha> [--task <text>]\n')
  process.exit(2)
}

const env = loadEnv(process.env)
const jev = jevConfig(env)
if (!jev.baseUrl || !jev.apiKey) {
  process.stderr.write('JEV_BASE_URL and JEV_API_KEY are required.\n')
  process.exit(2)
}

const diff = execFileSync('git', ['diff', '--end-of-options', `${base}..${head}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (diff.length > MAX_DIFF_CHARS) {
  process.stderr.write(`diff is ${diff.length} chars, over the ${MAX_DIFF_CHARS} limit; review a smaller range.\n`)
  process.exit(2)
}
const task =
  flag('--task') ?? execFileSync('git', ['log', '--format=%s', '--end-of-options', `${base}..${head}`], { encoding: 'utf8' }).trim()
const state = { task, diff }

// The ledger and budget are local to this process (in-memory database).
const sql = await openDatabase(undefined)
await migrate(sql)
await setBudgetMax(sql, 'jev', env.JEV_BUDGET_MAX)
const transport = new HttpJevTransport(sql, jev.baseUrl, jev.apiKey, jev.model, fetch)
const ctx: AskContext = { transport, traceId: `jev-review-${Date.now()}`, purpose: 'jev_review' }

const scores: Record<string, unknown> = {}
let exit = 0
for (const question of JEV_REVIEW_SET.questions) {
  const q = { prompt: question.prompt }
  const options = question.options ?? []
  const outcome =
    question.type === 'boolean'
      ? await askNoul(ctx, state, q)
      : question.type === 'choice'
        ? await askChoice(ctx, state, q, options)
        : await askScore(ctx, state, q, options)
  if (outcome.status === 'ok') scores[question.id] = outcome.data
  else {
    scores[question.id] = { status: outcome.status, error: 'error' in outcome ? outcome.error : undefined }
    exit = 1
  }
}
await sql.close()
process.stdout.write(
  `${JSON.stringify({ question_set: { id: JEV_REVIEW_SET.id, sha: JEV_REVIEW_SET.sha }, base, head, scores }, null, 2)}\n`,
)
process.exit(exit)
