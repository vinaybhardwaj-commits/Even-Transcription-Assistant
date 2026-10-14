import { createServer } from 'node:http'
import { bootApp } from './boot.js'
import { jevReadiness } from './config.js'
import { leaseNext } from './ingest/queue.js'
import { runQueuedJob } from './api/http.js'
import { log } from './log.js'
import { runLeasedWork } from './pipeline/audit.js'
import { AGENTS } from './agents/index.js'
import { healthOf, startWorkerLoop } from './jobs/loop.js'
import { createRetentionRunner } from './jobs/retention.js'
import { createBridge } from './platform/ubus/bridge.js'

const started = await bootApp({ role: 'worker' })
const owner = `worker:${process.pid}`
const retention = createRetentionRunner({ sql: started.sql, agents: AGENTS })
const bridge = createBridge(started.sql)
bridge?.start()

const health = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && path === '/health') {
    const h = healthOf(workerLoop.tickAgeS(), started.env.WORKER_POLL_MS, jevReadiness(started.env))
    res.writeHead(h.http, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(h.body))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ status: 'failed', error: { type: 'not_found', message: 'No route matches this path.' } }))
})
health.listen(started.env.PORT, '0.0.0.0', () => {
  log('info', 'listen', { role: 'worker', path: '/health' })
})

const workerLoop = startWorkerLoop({
  pollMs: started.env.WORKER_POLL_MS,
  heartbeat: (tick_age_s) => log('info', 'worker.heartbeat', { tick_age_s }),
  heartbeatMs: started.env.NEWCAT_HEARTBEAT_S * 1000,
  paused: () => bridge?.paused === true,
  retentionTick: () => retention.tick(),
  runJob: () => runQueuedJob(started.deps, owner),
  lease: () => leaseNext(started.sql, owner),
  runLeased: (work) =>
    runLeasedWork(
      {
        sql: started.sql,
        models: started.deps.models,
        jev: started.deps.jev,
        embedder: started.deps.embedder,
        rerank: started.env.BEDROCK_RERANK,
      },
      work,
      started.env.ABSTENTION_BACKLOG_DAYS,
    ),
  onStop: () => {
    bridge?.stop()
    health.close()
  },
  closers: [async () => started.closeCdmss?.(), () => started.sql.close()],
  warn: (error_type) => log('warn', 'worker', { error_type }),
  exit: (code) => process.exit(code),
})
const { loop, stop } = workerLoop
const stopped = () => workerLoop.stopped()

process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())

try {
  await loop
} catch (error) {
  if (!stopped()) throw error
}
await stop()
