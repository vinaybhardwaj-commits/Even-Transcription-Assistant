import path from 'node:path'
import { jevConfig, loadEnv } from '../config.js'
import { migrate } from '../db/migrate.js'
import { openDatabase } from '../db/open.js'
import { HttpJevTransport } from '../decide/transport.js'
import { newId } from '../ids.js'
import { calibrateValidity } from './jev-calibration.js'
import { loadGold } from './harness.js'

const args = process.argv.slice(2)
function flag(name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}

const goldPath = path.resolve(flag('--gold', 'fixtures/gold/safety-v1.json'))
const env = loadEnv(process.env)
const jev = jevConfig(env)
const doc = loadGold(goldPath)
const configured = Boolean(jev.baseUrl && jev.apiKey)

if (!configured) {
  const report = await calibrateValidity(doc, null, { model: jev.model, traceId: 'jev-calibration' })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.status === 'gold_rejected' || report.status === 'error' ? 1 : 0)
}

const sql = await openDatabase(env.DATABASE_URL)
try {
  await migrate(sql)
  const transport = new HttpJevTransport(sql, jev.baseUrl, jev.apiKey, jev.model, fetch)
  const report = await calibrateValidity(doc, transport, { model: jev.model, traceId: newId() })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.status === 'measured' ? 0 : 1)
} finally {
  await sql.close()
}
