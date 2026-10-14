import { loadEnv } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { openDatabase } from '../src/db/open.js'
import { loadTitanBatchOutput } from '../src/evidence/batch.js'
import { assertCorpusDatabase } from '../src/evidence/import.js'

const output = process.argv[2]
const manifest = process.argv[3]
if (!output || !manifest || output.startsWith('--') || manifest.startsWith('--')) {
  process.stderr.write('usage: npm run corpus:batch-load -- <bedrock-output.jsonl> <manifest.jsonl>\n')
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
const report = await loadTitanBatchOutput(sql, output, manifest)
await sql.close()
process.stdout.write(`${JSON.stringify(report)}\n`)
if (report.status === 'failed') process.exit(1)
