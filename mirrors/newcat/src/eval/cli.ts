import path from 'node:path'
import { evaluateGold, loadGold } from './harness.js'

const args = process.argv.slice(2)
function flag(name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}

const goldPath = path.resolve(flag('--gold', 'fixtures/gold/safety-v1.json'))
const runs = Number(flag('--runs', '3'))
const seed = Number(flag('--seed', '1'))
const report = await evaluateGold(loadGold(goldPath), runs, seed)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(report.result === 'PASS' ? 0 : 1)
