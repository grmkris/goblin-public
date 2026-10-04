import type { PiOperationResult, PiReceipt } from 'agents/harness/pi'
import type { VerifiedMcpPrincipal } from './auth/principal.ts'

export interface AgentRpc extends Rpc.DurableObjectBranded {
  readonly submit: (input: string, operationId: string) => Promise<PiReceipt>
  readonly submitAuthenticated: (
    input: string,
    operationId: string,
    principal: VerifiedMcpPrincipal,
  ) => Promise<PiReceipt>
  readonly wait: (operationId: string) => Promise<PiOperationResult>
  readonly stop: (operationId?: string) => Promise<boolean>
}

export interface RuntimeEnv {
  readonly AGENTS: DurableObjectNamespace<AgentRpc>
  readonly AUTH_DB: D1Database
  readonly APP_URL: string
  readonly BETTER_AUTH_SECRET: string
  readonly OWNER_EMAIL: string
  readonly OWNER_BOOTSTRAP_TOKEN: string
  readonly MODEL_BASE_URL: string
  readonly MODEL_ID: string
  readonly MODEL_KEY: string
  readonly MCP_SERVERS?: string
  readonly MCP_TOKENS?: string
  readonly STAGE?: 'local' | 'dev' | 'test'
}
