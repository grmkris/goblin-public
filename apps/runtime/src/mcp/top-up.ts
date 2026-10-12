import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import type { ServerProfile, WalletStatus } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { Chats } from '../chats/service.ts'
import { Forbidden } from '../http/errors.ts'
import { Notices } from '../notices/service.ts'
import { FlowEvents } from '../observability/flows.ts'
import { reportAndRecover, safeErrorType } from '../observability/report.ts'
import { writeNotice } from '../routines/notices.ts'
import { isRecord } from '../runtime/digest.ts'
import { profileOf } from './first-class.ts'
import { named } from './labels.ts'
import { McpConnections, McpServers, Spending } from './service.ts'
import { type SpendRule, type SpentRow, dollars, microsOf, withinRule } from './spend.ts'
import type { UrlPrompt } from './types.ts'

// Automatic top-ups of prepaid servers (ADR 0049): a first-class server that keeps its own balance (Mercator) is topped
// up from the owner's Goblin Wallet before a paid job it is short for, by the `funding` caller, under the owner's
// top-up rule. Every top-up is recorded in the spend table (tool `topup`, by its operation id) with where it goes
// before it is sent, and the agent's own check lets the wallet's transfer out only as that record says.

/** The tool key a prepaid server's top-ups are recorded and ruled under, in the spend tables (ADR 0044). */
export const TOP_UP_TOOL = 'topup'
/** The least a top-up moves; smaller ones would only cost fees. */
const MIN_TOP_UP = 2_000_000
const DOLLAR = 1_000_000

/** Where a top-up goes, as it is recorded and checked: `<chain>:<token>:<address>`, the address lower case. */
export const destinationOf = (chain: string, token: string, address: string): string =>
  `${chain}:${token}:${address.toLowerCase()}`

/** The operation id of the `n`th top-up of a prepaid connection: the wallet keys the transfer by it. */
export const topUpOperation = (connectionId: string, n: number): string => `topup:${connectionId}:${String(n)}`

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * The agent's own check of a `funding` call (ADR 0049): it goes out only as a top-up goblin recorded, the record named
 * by its `operation_id`, moving exactly the recorded amount, in its chain and token, to its address. The owner's rule
 * (or their approval) recorded it, so it is their decision for the wallet's transfer, which asks first otherwise.
 */
export function assertRecordedTopUp(row: SpentRow | undefined, args: Record<string, unknown>): void {
  const [chain, token, to] = [text(args['chain']), text(args['token']), text(args['to'])]
  const amount = microsOf(args['amount'])
  if (
    row === undefined ||
    row.tool !== TOP_UP_TOOL ||
    row.approvalId !== text(args['operation_id']) ||
    chain === undefined ||
    token === undefined ||
    to === undefined ||
    row.destination !== destinationOf(chain, token, to) ||
    amount !== row.micros ||
    microsOf(args['max_usd']) !== row.micros
  )
    throw new Forbidden({ reason: 'not a top-up goblin recorded' })
}

/**
 * A balance a server reports, a decimal string with any number of places, in whole micro-dollars cut down (never
 * rounded up); nothing for anything else, which is not zero (an unreadable chain reads as no balance).
 */
export const balanceMicros = (value: string | undefined): number | undefined => {
  const match = value === undefined ? null : /^(\d{1,12})(?:\.(\d+))?$/u.exec(value)
  if (match === null) return undefined
  const [, whole = '0', fraction = ''] = match
  return Number(whole) * DOLLAR + Number(fraction.slice(0, 6).padEnd(6, '0'))
}

/** What a top-up moves for `shortfall`: rounded up to a whole dollar, and at least `MIN_TOP_UP`. */
export const topUpAmount = (shortfall: number): number => Math.max(MIN_TOP_UP, Math.ceil(shortfall / DOLLAR) * DOLLAR)

/** The profile's default rule, in micro-dollars: up to `perTopUp` a top-up, `daily` a day. */
const defaultRule = (prepaid: NonNullable<ServerProfile['prepaid']>): SpendRule => {
  const daily = microsOf(prepaid.daily)
  return { perJob: microsOf(prepaid.perTopUp) ?? 0, ...(daily === undefined ? {} : { daily }) }
}

/** The owner's top-up rule for a prepaid connection, or its profile's default until they change it. */
export const topUpRule = (connectionId: string, prepaid: NonNullable<ServerProfile['prepaid']>) =>
  Effect.map(
    Spending.use((spending) => spending.rule(connectionId, TOP_UP_TOOL)),
    (rule) => rule ?? defaultRule(prepaid),
  )

/** Dollars and cents for the owner's receipt line: `$5.00`, `$12.50`. */
const cents = (micros: number): string => {
  const whole = Math.floor(micros / DOLLAR)
  return `$${String(whole)}.${String(Math.floor((micros % DOLLAR) / 10_000)).padStart(2, '0')}`
}

/** What `ensureFunded` did about a prepaid server's balance before its paid job goes out. */
export type Funded =
  /** Nothing to do: not prepaid, funded enough, or its balance could not be read (a job then finds out itself). */
  | { readonly kind: 'ready' }
  /** goblin moved `micros` to it from the Goblin Wallet under the owner's rule. */
  | { readonly kind: 'moved'; readonly micros: number }
  /** The wallet asks the owner first (a new recipient, ADR 0042): the top-up waits on that request. */
  | { readonly kind: 'asked'; readonly prompt: UrlPrompt; readonly transfer: TopUpTransfer }
  /** The job cannot be funded now: goblin's words for the model, which say what the owner can do. */
  | { readonly kind: 'refused'; readonly text: string }

/** The wallet transfer of one top-up, as recorded: where it goes, its arguments and the wallet connection. */
export type TopUpTransfer = {
  readonly wallet: string
  readonly tool: string
  readonly arguments: Readonly<Record<string, string>>
  readonly micros: number
}

/** The job a top-up is for: its conversation, when the model's call made it, for the receipt and the flow. */
export type TopUpFor = { readonly session: string | null }

/** The owner's connected Goblin Wallet with a funding tool, if any. */
const fundingWallet = Effect.gen(function* () {
  const servers = yield* McpServers.use((owner) => owner.list())
  const wallet = servers.find(
    (server) => server.status === 'connected' && profileOf(server.endpoint)?.funding !== undefined,
  )
  const tool = wallet === undefined ? undefined : profileOf(wallet.endpoint)?.funding?.tool
  return wallet === undefined || tool === undefined ? undefined : { connectionId: wallet.connectionId, tool }
})

/** The prepaid server's status as goblin reads it for a top-up: goblin's own work, never the owner's console. */
const readStatus = (connectionId: string) =>
  Effect.gen(function* () {
    const connections = yield* McpConnections
    const statusTool = profileOf((yield* connections.server(connectionId)).endpoint)?.statusTool
    if (statusTool === undefined) return undefined
    const result = yield* connections.callTool(connectionId, statusTool.name, {}, { use: 'background' })
    return result.isError === true ? undefined : statusTool.read(result.structuredContent)
  }).pipe(
    // expected: a balance that cannot be read leaves the job to find out for itself
    Effect.orElseSucceed((): WalletStatus | undefined => undefined),
  )

/** A content-free flow step for a top-up (ADR 0024): its operation, its chat and how it ended. */
const recordFlow = (session: string | null, operationId: string, status: 'ok' | 'refused' | 'error', error?: string) =>
  Effect.gen(function* () {
    const chat = session === null ? undefined : Option.getOrUndefined(yield* (yield* Chats).chatOf(session))
    yield* FlowEvents.record({
      flow: 'top_up',
      via: 'system',
      actor: 'agent',
      operationId,
      ...(chat === undefined ? {} : { chat }),
      status,
      ...(error === undefined ? {} : { errorType: error }),
    })
  })

/**
 * The owner's receipt of a top-up that went through (ADR 0049): an Activity notification and a line in the job's chat,
 * "Moved $5.00 to Mercator from your Goblin Wallet". It never fails the job it funded.
 */
export const topUpReceipt = (
  topUp: { readonly session: string | null; readonly prepaid: string; readonly operation: string } & TopUpTransfer,
) =>
  Effect.gen(function* () {
    const { operation } = topUp
    if (topUp.session === null) return
    const chat = Option.getOrUndefined(yield* (yield* Chats).chatOf(topUp.session))
    if (chat === undefined) return
    const labels = yield* (yield* McpServers).labels()
    const wallet = labels.get(topUp.wallet) ?? 'Goblin Wallet'
    const id = `notice:${operation}`
    const now = yield* Clock.currentTimeMillis
    yield* (yield* Notices).claim(
      {
        id,
        routineId: `topup:${topUp.prepaid}`,
        source: 'event',
        chatId: chat,
        entryRequestId: id,
        connectionId: topUp.wallet,
        label: wallet,
        title: `Moved ${cents(topUp.micros)} to ${labels.get(topUp.prepaid) ?? topUp.prepaid} from your ${wallet}`,
        body: null,
        url: null,
        at: now,
        createdAt: now,
      },
      false,
    )
    yield* writeNotice(id)
  }).pipe(reportAndRecover('mcp.topUpReceipt', undefined))

/**
 * Sends one recorded top-up from the Goblin Wallet as the `funding` caller, declaring URL elicitation, so the wallet's
 * first-use approval of a new recipient reaches the owner as a URL request (ADR 0042).
 */
const sendTopUp = (transfer: TopUpTransfer) =>
  McpConnections.use((connections) =>
    connections.callModelTool(transfer.wallet, transfer.tool, transfer.arguments, {
      caller: 'funding',
      use: 'foreground',
    }),
  )

/** The wallet operation's status in a transfer's answer: `confirmed`, `submitted`, `failed`, `awaiting_approval`, … */
const operationStatus = (structured: unknown): string | undefined => {
  const operation = isRecord(structured) ? structured['operation'] : undefined
  return isRecord(operation) ? text(operation['status']) : undefined
}

/** The wallet's refusal code, bounded to a safe word (never its message: remote content stays out of goblin's words). */
const refusalCode = (structured: unknown): string | undefined => {
  const error = isRecord(structured) ? structured['error'] : undefined
  const code = isRecord(error) ? text(error['code']) : undefined
  return code !== undefined && /^[a-z0-9_]{1,40}$/u.test(code) ? code : undefined
}

/** A transfer the wallet answered as sent (or on its way on chain). */
const MOVED: ReadonlySet<string> = new Set(['submitted', 'confirmed', 'delivered'])

/** How a top-up's transfer the wallet answered ended: moved, or refused with goblin's words for it. */
export const transferOutcome = (
  result: { readonly isError?: boolean | undefined; readonly structuredContent?: unknown },
  label: { readonly wallet: string; readonly prepaid: string; readonly amount: string },
): { readonly moved: true } | { readonly moved: false; readonly text: string; readonly code: string } => {
  const status = operationStatus(result.structuredContent)
  if (result.isError !== true && status !== undefined && MOVED.has(status)) return { moved: true }
  const code = refusalCode(result.structuredContent) ?? status ?? 'refused'
  const why =
    status === 'awaiting_approval'
      ? `${label.wallet} holds it for your approval in the wallet`
      : `${label.wallet} did not send it (${code})`
  return {
    moved: false,
    code,
    text: `goblin tried to top up ${label.prepaid} with ${label.amount} from ${label.wallet}, but ${why}. The job did not run.`,
  }
}

/** A recorded top-up on its way: the transfer, the job it is for and the names its words use. */
type Recorded = {
  readonly transfer: TopUpTransfer
  readonly operation: string
  readonly prepaid: string
  readonly job: TopUpFor
  readonly names: { readonly wallet: string; readonly prepaid: string }
}

/** Sends a recorded top-up and says how it ended: moved (with its receipt), asked by the wallet, or refused. */
const sendRecorded = ({ transfer, operation, prepaid, job, names }: Recorded) =>
  Effect.gen(function* () {
    const amount = dollars(transfer.micros)
    const sent = yield* Effect.result(sendTopUp(transfer))
    if (Result.isFailure(sent)) {
      const error = safeErrorType(sent.failure)
      yield* recordFlow(job.session, operation, 'error', error)
      return {
        kind: 'refused',
        text: `goblin tried to top up ${names.prepaid} with ${amount} from ${names.wallet}, but the transfer did not complete (${error}); it may have gone through, so check the wallet before trying again. The job did not run.`,
      } satisfies Funded
    }
    if (sent.success.kind === 'url') {
      yield* recordFlow(job.session, operation, 'ok')
      return { kind: 'asked', prompt: sent.success.prompt, transfer } satisfies Funded
    }
    const outcome = transferOutcome(sent.success.result, { ...names, amount })
    if (!outcome.moved) {
      yield* recordFlow(job.session, operation, 'refused', outcome.code)
      return { kind: 'refused', text: outcome.text } satisfies Funded
    }
    yield* recordFlow(job.session, operation, 'ok')
    yield* topUpReceipt({ ...transfer, session: job.session, prepaid, operation })
    return { kind: 'moved', micros: transfer.micros } satisfies Funded
  })

/** The rule in the model's words: "up to $5 a top-up and $20 a day". */
const ruleWords = (rule: SpendRule): string =>
  `up to ${dollars(rule.perJob)} a top-up${rule.daily === undefined ? '' : ` and ${dollars(rule.daily)} a day`}`

/** Where a prepaid server is funded and how much it holds, when goblin can account for both; nothing otherwise. */
const fundable = (prepaid: NonNullable<ServerProfile['prepaid']>, status: WalletStatus | undefined) => {
  const depositTo = status?.depositTo
  const balance = balanceMicros(status?.tokens.find((token) => token.symbol === prepaid.token)?.balance)
  if (balance === undefined || depositTo === undefined) return undefined
  return depositTo.chain === prepaid.chain && depositTo.token === prepaid.token ? { depositTo, balance } : undefined
}

/**
 * Before a prepaid server's paid job of `micros` goes out (ADR 0049): reads the server's balance from its own status
 * and, when it is short, tops it up from the Goblin Wallet by the shortfall rounded up to a dollar (at least $2). Within
 * the owner's top-up rule (by default $5 a top-up and $20 a day) it is recorded with where it goes, then sent as the
 * `funding` caller; above the rule, or without a wallet, the job is refused with words that say what to approve. A
 * balance or address goblin cannot account for moves nothing, and the job finds out for itself.
 */
export const ensureFunded = (connectionId: string, micros: number, job: TopUpFor) =>
  Effect.gen(function* () {
    const prepaid = profileOf((yield* (yield* McpConnections).server(connectionId)).endpoint)?.prepaid
    if (prepaid === undefined) return { kind: 'ready' } satisfies Funded
    const read = fundable(prepaid, yield* readStatus(connectionId))
    if (read === undefined || read.balance >= micros) return { kind: 'ready' } satisfies Funded
    const labels = yield* (yield* McpServers).labels()
    const name = named(labels, connectionId)
    const amount = topUpAmount(micros - read.balance)
    const wallet = yield* fundingWallet
    const short = `${name}'s balance (${dollars(read.balance)}) is short of this job (${dollars(micros)})`
    if (wallet === undefined)
      return {
        kind: 'refused',
        text: `${short}, and no Goblin Wallet is connected to top it up from. Ask the owner to connect it, or to add funds to ${name} themselves. The job did not run.`,
      } satisfies Funded
    const walletName = named(labels, wallet.connectionId)
    const spending = yield* Spending
    const rule = yield* topUpRule(connectionId, prepaid)
    const operation = topUpOperation(connectionId, (yield* spending.count(connectionId, TOP_UP_TOOL)) + 1)
    const destination = destinationOf(prepaid.chain, prepaid.token, read.depositTo.address)
    const spent = {
      approvalId: operation,
      connectionId,
      tool: TOP_UP_TOOL,
      micros: amount,
      standing: true,
      destination,
    }
    const fits = withinRule(rule, amount, yield* spending.spentToday(connectionId, TOP_UP_TOOL))
    if (!fits || !(yield* spending.record(spent, rule))) {
      yield* recordFlow(job.session, operation, 'refused', 'above_rule')
      return {
        kind: 'refused',
        text: `${short}. Topping it up by ${dollars(amount)} from ${walletName} is above the owner's top-up rule (${ruleWords(rule)}). The job did not run. Ask the owner to raise the rule on ${name}'s card in Connections (or to add funds to ${name} themselves), then create the job again.`,
      } satisfies Funded
    }
    const plain = dollars(amount).slice(1)
    const args = {
      chain: prepaid.chain,
      token: prepaid.token,
      to: read.depositTo.address,
      amount: plain,
      max_usd: plain,
    }
    const memo = `goblin top-up for ${name}`.slice(0, 120)
    const transfer = {
      wallet: wallet.connectionId,
      tool: wallet.tool,
      micros: amount,
      arguments: { ...args, operation_id: operation, memo },
    }
    return yield* sendRecorded({
      transfer,
      operation,
      prepaid: connectionId,
      job,
      names: { wallet: walletName, prepaid: name },
    })
  })

/** The job a call is, when it is a prepaid server's paid tool: its amount in micro-dollars (ADR 0044's argument). */
export const prepaidJob = (endpoint: string, name: string, args: Record<string, unknown>): number | undefined => {
  const profile = profileOf(endpoint)
  if (profile?.prepaid === undefined || profile.spend?.tool !== name) return undefined
  return microsOf(args[profile.spend.argument])
}

/** goblin's own result for a job it did not send because it could not be funded: words for the model to relay. */
export const unfundedResult = (connectionId: string, name: string, words: string): ToolExecutionResult => ({
  content: [{ type: 'text', text: words }],
  isError: true,
  control: { terminate: true },
  diagnostics: [{ severity: 'info', code: 'top_up_refused', message: 'The job could not be funded.' }],
  details: { kind: 'top-up-refused', connectionId, name },
})

/** The top-up a URL request stands for (ADR 0049), when its call is a recorded top-up of the wallet's funding tool. */
export const topUpOf = (request: { readonly endpoint: string; readonly name: string }, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    if (profileOf(request.endpoint)?.funding?.tool !== request.name) return undefined
    const operation = text(args['operation_id'])
    if (operation?.startsWith('topup:') !== true) return undefined
    const row = yield* (yield* Spending).find(operation)
    return row?.tool === TOP_UP_TOOL ? row : undefined
  })

/** Names for a transfer's outcome when only whether it moved is wanted. */
export const NAMELESS = { wallet: '', prepaid: '', amount: '' } as const

/**
 * What a settled top-up URL request tells the job's turn: the top-up went out, so the job can be created again; the
 * wallet refused it; or, for any other end, what a URL request says (`otherwise`).
 */
export const topUpSettledText = (
  state: string,
  result: { readonly isError?: boolean | undefined; readonly structuredContent?: unknown } | undefined,
  names: { readonly wallet: string; readonly prepaid: string; readonly micros: number; readonly otherwise: string },
): string => {
  if (state !== 'completed' || result === undefined) return names.otherwise
  const amount = dollars(names.micros)
  const outcome = transferOutcome(result, { wallet: names.wallet, prepaid: names.prepaid, amount })
  if (!outcome.moved) return outcome.text
  return `The owner finished the step ${names.wallet} asked for, and goblin's ${amount} top-up of ${names.prepaid} went out. The job itself did not run yet: create it again with the same arguments, once.`
}
