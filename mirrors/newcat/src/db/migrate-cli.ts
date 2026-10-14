import { assertBootSecrets, loadEnv } from '../config.js'
import { openDatabase } from './open.js'
import { migrate } from './migrate.js'

const env = loadEnv(process.env)
assertBootSecrets(env)
const sql = await openDatabase(env.DATABASE_URL)
try {
  const applied = await migrate(sql)
  process.stdout.write(`${applied.length === 0 ? 'no pending migrations\n' : `applied ${applied.join(', ')}\n`}`)
} finally {
  await sql.close()
}
