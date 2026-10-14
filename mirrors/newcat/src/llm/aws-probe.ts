import { BedrockClient, ListModelInvocationJobsCommand } from '@aws-sdk/client-bedrock'
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam'
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { resolveBedrockAuth, type BedrockAuth, type Env } from '../config.js'
import { credentialProvider } from './aws.js'

const BEDROCK_JOB_REGION = 'ap-south-1'
const SIMULATED_ACTIONS = ['s3:CreateBucket', 'iam:PassRole', 'bedrock:CreateModelInvocationJob'] as const

export interface AwsCall {
  allowed: boolean
  error_type: string | null
}

export interface AwsProbeReport {
  status: 'ok'
  auth_mode: BedrockAuth
  caller_arn: string | null
  policy_source_arn: string | null
  s3_list_buckets: AwsCall
  bedrock_list_model_invocation_jobs: AwsCall & { region: typeof BEDROCK_JOB_REGION }
  iam_simulate: {
    s3_create_bucket: AwsCall
    iam_pass_role: AwsCall
    bedrock_create_model_invocation_job: AwsCall
  }
}

export interface AwsProbeIo {
  listBuckets(): Promise<void>
  listModelInvocationJobs(): Promise<void>
  callerArn(): Promise<string>
  simulate(policySourceArn: string): Promise<{ action: string; allowed: boolean; decision: string }[]>
}

function errorType(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof (error as { name: unknown }).name === 'string') {
    return (error as { name: string }).name.slice(0, 80)
  }
  return 'Error'
}

async function attempt(run: () => Promise<void>): Promise<AwsCall> {
  try {
    await run()
    return { allowed: true, error_type: null }
  } catch (error) {
    return { allowed: false, error_type: errorType(error) }
  }
}

/** STS assumed-role session ARNs are not valid PolicySourceArn values. */
export function policySourceArn(callerArn: string): string | null {
  const assumed = /^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//.exec(callerArn)
  if (assumed) return `arn:aws:iam::${assumed[1]}:role/${assumed[2]}`
  if (/^arn:aws:iam::\d+:(role|user)\//.exec(callerArn)) return callerArn
  return null
}

function actionResult(
  action: (typeof SIMULATED_ACTIONS)[number],
  decisions: { action: string; allowed: boolean; decision: string }[],
  simulateError: string | null,
): AwsCall {
  if (simulateError) return { allowed: false, error_type: simulateError }
  const row = decisions.find((item) => item.action === action)
  if (!row) return { allowed: false, error_type: 'missing_evaluation' }
  return { allowed: row.allowed, error_type: row.allowed ? null : row.decision }
}

export function defaultAwsProbeIo(env: Env): AwsProbeIo {
  const credentials = credentialProvider(env)
  const config = {
    region: env.AWS_STS_REGION,
    ...(credentials ? { credentials } : {}),
  }
  const s3 = new S3Client(config)
  const bedrock = new BedrockClient({ ...config, region: BEDROCK_JOB_REGION })
  const iam = new IAMClient(config)
  const sts = new STSClient(config)
  return {
    async listBuckets() {
      await s3.send(new ListBucketsCommand({}))
    },
    async listModelInvocationJobs() {
      await bedrock.send(new ListModelInvocationJobsCommand({ maxResults: 1 }))
    },
    async callerArn() {
      const out = await sts.send(new GetCallerIdentityCommand({}))
      if (!out.Arn) {
        const error = new Error('STS did not return an ARN.')
        error.name = 'MissingCallerArn'
        throw error
      }
      return out.Arn
    },
    async simulate(sourceArn: string) {
      const out = await iam.send(
        new SimulatePrincipalPolicyCommand({
          PolicySourceArn: sourceArn,
          ActionNames: [...SIMULATED_ACTIONS],
        }),
      )
      return (out.EvaluationResults ?? []).map((row) => ({
        action: row.EvalActionName ?? '',
        allowed: row.EvalDecision === 'allowed',
        decision: row.EvalDecision ?? 'missing',
      }))
    },
  }
}

/** Read-only calls with the federated credentials. Nothing is created. */
export async function probeAws(env: Env, io?: AwsProbeIo): Promise<AwsProbeReport> {
  const client = io ?? defaultAwsProbeIo(env)
  const s3 = await attempt(() => client.listBuckets())
  const jobs = await attempt(() => client.listModelInvocationJobs())
  let callerArn: string | null = null
  let sourceArn: string | null = null
  let simulateError: string | null = null
  let decisions: { action: string; allowed: boolean; decision: string }[] = []
  try {
    callerArn = await client.callerArn()
    sourceArn = policySourceArn(callerArn)
    if (!sourceArn) simulateError = 'invalid_principal_arn'
    else decisions = await client.simulate(sourceArn)
  } catch (error) {
    simulateError = errorType(error)
  }
  return {
    status: 'ok',
    auth_mode: resolveBedrockAuth(env),
    caller_arn: callerArn,
    policy_source_arn: sourceArn,
    s3_list_buckets: s3,
    bedrock_list_model_invocation_jobs: { ...jobs, region: BEDROCK_JOB_REGION },
    iam_simulate: {
      s3_create_bucket: actionResult('s3:CreateBucket', decisions, simulateError),
      iam_pass_role: actionResult('iam:PassRole', decisions, simulateError),
      bedrock_create_model_invocation_job: actionResult('bedrock:CreateModelInvocationJob', decisions, simulateError),
    },
  }
}
