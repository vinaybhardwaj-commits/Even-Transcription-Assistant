import { mintConsumer, revokeConsumer } from '../src/auth/keys.js'
import { loadEnv } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { openDatabase } from '../src/db/open.js'
import type { Audience } from '../src/facts/schema.js'

const AUDIENCES = new Set(['internal', 'operator', 'doctor'])

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

const command = process.argv[2]
const env = loadEnv(process.env)
if (!env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is required. The key CLI does not write to the in-memory database.\n')
  process.exit(1)
}

const sql = await openDatabase(env.DATABASE_URL)
await migrate(sql)

if (command === 'mint') {
  const name = flag('--name')
  const audience = flag('--audience')
  const scopes = flag('--scopes')?.split(',').map((scope) => scope.trim()).filter(Boolean)
  if (!name || !audience || !AUDIENCES.has(audience) || !scopes || scopes.length === 0) {
    process.stderr.write('usage: npm run keys -- mint --name <consumer> --audience internal|operator|doctor --scopes a,b\n')
    process.exit(1)
  }
  let failed = false
  try {
    const minted = await mintConsumer(sql, { name, audience: audience as Audience, scopes })
    process.stdout.write(`${minted.token}\n`)
  } catch {
    process.stderr.write('mint failed\n')
    failed = true
  }
  await sql.close()
  process.exit(failed ? 1 : 0)
}

if (command === 'revoke') {
  const name = flag('--name')
  if (!name) {
    process.stderr.write('usage: npm run keys -- revoke --name <consumer>\n')
    process.exit(1)
  }
  const revoked = await revokeConsumer(sql, name)
  await sql.close()
  if (!revoked) {
    process.stderr.write('no active consumer with that name\n')
    process.exit(1)
  }
  process.stdout.write(`revoked ${name}\n`)
  process.exit(0)
}

process.stderr.write('usage: npm run keys -- mint|revoke ...\n')
process.exit(1)
