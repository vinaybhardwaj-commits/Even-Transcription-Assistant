import { createServer } from 'node:http'
import { bootApp } from './boot.js'
import { jevReadiness } from './config.js'
import { leaseNext } from './ingest/queue.js'
import { runQueuedJob } from './api/http.js'
import { log } from './log.js'
import { runLeasedWork } from './pipeline/audit.js'
import { createBridge } from './platform/ubus/bridge.js'

const started = await bootApp({ role: 'worker' })
const owner = `worker:${process.pid}`
let stopped = false
const bridge = createBridge(started.sql)
bridge?.start()

const health = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ status: 'ok', jev: jevReadiness(started.env) }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ status: 'failed', error: { type: 'not_found', message: 'No route matches this path.' } }))
})
health.listen(started.env.PORT, '0.0.0.0', () => {
  log('info', 'listen', { role: 'worker', path: '/health' })
})

function stop(): void {
  stopped = true
  bridge?.stop()
  health.close()
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)

while (!stopped) {
  if (bridge?.paused) {
    await new Promise((resolve) => setTimeout(resolve, started.env.WORKER_POLL_MS))
    continue
  }
  const ranJob = await runQueuedJob(started.deps, owner)
  const work = await leaseNext(started.sql, owner)
  if (work) {
    await runLeasedWork(
      {
        sql: started.sql,
        models: started.deps.models,
        jev: started.deps.jev,
        embedder: started.deps.embedder,
        rerank: started.env.BEDROCK_RERANK,
      },
      work,
      started.env.ABSTENTION_BACKLOG_DAYS,
    )
  }
  if (!ranJob && !work) await new Promise((resolve) => setTimeout(resolve, started.env.WORKER_POLL_MS))
}
