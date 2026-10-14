import { zodToJsonSchema } from 'zod-to-json-schema'
import { CAPABILITIES } from './registry.js'
import { RequestEnvelope } from './schema.js'

export function buildOpenApi(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {
    RequestEnvelope: zodToJsonSchema(RequestEnvelope, { target: 'openApi3' }),
  }
  for (const capability of CAPABILITIES) {
    schemas[`${capability.id.replace(/\./g, '_')}_input`] = zodToJsonSchema(capability.input, { target: 'openApi3' })
    schemas[`${capability.id.replace(/\./g, '_')}_output`] = zodToJsonSchema(capability.output, { target: 'openApi3' })
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'NewCat',
      version: 'v1',
      description:
        'Headless clinical audit API. /v1 is the current major version. Breaking changes ship as /v2 and the previous major is deprecated for 90 days.',
    },
    paths: {
      '/health': {
        get: {
          summary: 'Liveness',
          responses: { '200': { description: 'Process is up. Reports jev readiness and no clinical data.' } },
        },
      },
      '/v1/invoke': {
        post: {
          summary: 'Invoke a registered capability',
          security: [{ bearer: [] }],
          responses: { '200': { description: 'Terminal envelope' }, '202': { description: 'Async accept' } },
        },
      },
      '/v1/jobs/{id}': { get: { summary: 'Read an async job', security: [{ bearer: [] }] } },
      '/v1/events': { get: { summary: 'Read webhook and job events', security: [{ bearer: [] }] } },
      '/v1/agents/{agentId}/runs/{runId}': {
        get: {
          summary:
            'Read one agent run: metadata and finding positions only, no input or quote text. Needs the agent id as a key scope. Doctor audience refused. Governance responses omit served model ids.',
          security: [{ bearer: [] }],
          parameters: [
            { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Run metadata and findings' },
            '403': { description: 'Missing scope or audience not permitted' },
            '404': { description: 'Unknown agent or run' },
          },
        },
      },
      '/v1/capabilities': { get: { summary: 'List capabilities', security: [{ bearer: [] }] } },
      '/v1/internal/work/tick': { post: { summary: 'Lease and run one work item', security: [{ cron: [] }] } },
      '/v1/internal/corpus/import-sample': {
        post: {
          summary: 'Admin import of at most 150 JSONL corpus lines. Signs rows as cat-corpus-import and returns counts and embed cost.',
          security: [{ bearer: [] }],
          responses: { '200': { description: 'Import counts' }, '422': { description: 'Invalid or oversized sample' } },
        },
      },
      '/v1/internal/bedrock/check': {
        post: {
          summary: 'Admin check of the Bedrock auth mode, ID-token mint, AssumeRole, caller ARN, and a one-token Converse call',
          security: [{ bearer: [] }],
        },
      },
      '/v1/internal/aws/probe': {
        get: {
          summary:
            'Admin read-only probe of S3 ListBuckets, Bedrock ListModelInvocationJobs in ap-south-1, and IAM SimulatePrincipalPolicy for s3:CreateBucket, iam:PassRole, and bedrock:CreateModelInvocationJob',
          security: [{ bearer: [] }],
        },
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        cron: { type: 'http', scheme: 'bearer' },
      },
      schemas,
    },
    'x-capabilities': CAPABILITIES.map((capability) => ({
      id: capability.id,
      version: capability.version,
      modes: capability.modes,
      required_scopes: capability.requiredScopes,
      audiences: capability.audiences,
    })),
  }
}
