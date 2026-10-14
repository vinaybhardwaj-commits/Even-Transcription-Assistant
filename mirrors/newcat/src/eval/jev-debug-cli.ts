import { jevConfig, loadEnv } from '../config.js'
import { debugFixture } from './jev-debug.js'
import { loadGold } from './harness.js'

const fixtureId = process.argv[2]
if (!fixtureId) {
  process.stderr.write('usage: npm run jev:debug -- <fixture-id>\n')
  process.exit(2)
}

const env = loadEnv(process.env)
const jev = jevConfig(env)
if (!jev.baseUrl || !jev.apiKey) {
  process.stderr.write('JEV_BASE_URL and JEV_API_KEY are required.\n')
  process.exit(2)
}

try {
  const report = await debugFixture(loadGold('fixtures/gold/safety-v1.json'), fixtureId, {
    baseUrl: jev.baseUrl,
    apiKey: jev.apiKey,
    model: jev.model,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : 'debug failed'
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
