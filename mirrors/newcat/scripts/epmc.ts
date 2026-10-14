import { existsSync, readFileSync } from 'node:fs'
import { loadEnv } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { openDatabase } from '../src/db/open.js'
import { importEpmcQueries, parseQueryList } from '../src/evidence/epmc.js'
import { assertCorpusDatabase } from '../src/evidence/import.js'
import { applyBudgetCaps, buildEmbedder } from '../src/runtime.js'

const file = process.argv[2]
if (!file || file.startsWith('--')) {
  process.stderr.write('usage: npm run corpus:epmc -- <queries.txt>\n')
  process.exit(1)
}
if (!existsSync(file)) {
  process.stderr.write('query file not found\n')
  process.exit(1)
}

const env = loadEnv(process.env)
try {
  assertCorpusDatabase(env.DATABASE_URL)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'DATABASE_URL is required'}\n`)
  process.exit(1)
}

const queries = parseQueryList(readFileSync(file, 'utf8'))
const sql = await openDatabase(env.DATABASE_URL)
await migrate(sql)
await applyBudgetCaps(sql, env)
const maxPages = Number(process.env.EPMC_MAX_PAGES ?? '4')
const report = await importEpmcQueries(sql, buildEmbedder(sql, env), queries, {
  batchSize: env.EMBED_BATCH_SIZE,
  concurrency: env.EMBED_CONCURRENCY,
  maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 4,
})
await sql.close()
process.stdout.write(`${JSON.stringify(report)}\n`)
if (report.status === 'failed' || report.status === 'unavailable') process.exit(1)
