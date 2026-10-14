import { existsSync } from 'node:fs'
import { loadEnv } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { openDatabase } from '../src/db/open.js'
import { assertCorpusDatabase, importCorpusFile } from '../src/evidence/import.js'
import { applyBudgetCaps, buildEmbedder } from '../src/runtime.js'

const file = process.argv[2]
if (!file || file.startsWith('--')) {
  process.stderr.write('usage: npm run corpus:import -- <file.jsonl>\n')
  process.exit(1)
}
if (!existsSync(file)) {
  process.stderr.write('corpus file not found\n')
  process.exit(1)
}

const env = loadEnv(process.env)
try {
  assertCorpusDatabase(env.DATABASE_URL)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'DATABASE_URL is required'}\n`)
  process.exit(1)
}

const sql = await openDatabase(env.DATABASE_URL)
await migrate(sql)
await applyBudgetCaps(sql, env)
const report = await importCorpusFile(sql, buildEmbedder(sql, env), file, {
  signer: 'cat-corpus',
  batchSize: env.EMBED_BATCH_SIZE,
  concurrency: env.EMBED_CONCURRENCY,
})
await sql.close()
process.stdout.write(`${JSON.stringify(report)}\n`)
if (report.status === 'failed' || report.status === 'unavailable') process.exit(1)
