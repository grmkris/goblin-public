import type { SpendingChange, SpendingView, WalletStatus } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { NotFound } from '../http/errors.ts'
import { profileOf } from './first-class.ts'
import { McpConnections, McpGrants, Spending } from './service.ts'
import { type SpendRule, microsOf } from './spend.ts'

// What the owner does with a first-class server (ADR 0043): allow its recommended grants in one go, and read its status
// line. Both are the owner's own acts, through the owner API.

/** The profile of connection `connectionId`'s server; `NotFound` for one goblin does not support first-class. */
const profileFor = (connectionId: string) =>
  Effect.gen(function* () {
    const server = yield* (yield* McpConnections).server(connectionId)
    const profile = profileOf(server.endpoint)
    if (profile === undefined) return yield* new NotFound({ what: `profile for ${connectionId}` })
    return profile
  })

/**
 * Applies a first-class server's recommended grants: its free tools run when needed, its paid ones ask first. A tool
 * the server does not list now is skipped (it may come with a role the agent does not have yet).
 */
export const allowRecommended = (connectionId: string) =>
  Effect.gen(function* () {
    const profile = yield* profileFor(connectionId)
    const grants = yield* McpGrants
    const allow = (name: string) =>
      grants.setTool(connectionId, name, true).pipe(
        Effect.as(true),
        // expected: a tool the server does not list now is not allowed, and the rest still are
        Effect.catchTag('NotFound', () => Effect.succeed(false)),
      )
    for (const name of profile.recommended.run) yield* allow(name)
    for (const name of profile.recommended.ask)
      if (yield* allow(name)) yield* grants.setAskFirst(connectionId, name, true)
    return yield* grants.list()
  })

/**
 * A first-class server's status line, read from its status tool as the owner: null until the owner allowed that tool,
 * or when what the server answers does not fit goblin's schema for it.
 */
export const serverStatus = (connectionId: string) =>
  Effect.gen(function* () {
    const { statusTool } = yield* profileFor(connectionId)
    if (statusTool === undefined) return null
    const result = yield* (yield* McpConnections)
      .callTool(connectionId, statusTool.name, {}, { caller: 'human' })
      // expected: a status line is optional: not allowed yet, signed out or unreachable, the card shows none
      .pipe(Effect.option)
    if (Option.isNone(result) || result.value.isError === true) return null
    const read: WalletStatus | undefined = statusTool.read(result.value.structuredContent)
    return read ?? null
  })

/** Micro-dollars as a plain decimal the owner's form reads back: `5`, `1.25`. */
const plain = (micros: number): string => {
  const whole = Math.floor(micros / 1_000_000)
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/u, '')
  return fraction === '' ? String(whole) : `${String(whole)}.${fraction}`
}

/** A first-class server's paid tool, the owner's rule for it and today's total; null for a server without one. */
export const spendingView = (connectionId: string) =>
  Effect.gen(function* () {
    const { spend } = yield* profileFor(connectionId)
    if (spend === undefined) return null
    const spending = yield* Spending
    const rule = yield* spending.rule(connectionId, spend.tool)
    const spent = yield* spending.spentToday(connectionId, spend.tool)
    return {
      tool: spend.tool,
      ...(rule === undefined ? {} : { perJob: plain(rule.perJob) }),
      ...(rule?.daily === undefined ? {} : { daily: plain(rule.daily) }),
      spentToday: plain(spent),
    } satisfies SpendingView
  })

/** The rule `change` sets, or none (every job asks first again). */
const ruleOf = (change: SpendingChange): SpendRule | undefined => {
  const perJob = change.perJob === null ? undefined : microsOf(change.perJob)
  if (perJob === undefined) return undefined
  const daily = change.daily === null ? undefined : microsOf(change.daily)
  return daily === undefined ? { perJob } : { perJob, daily }
}

/** Sets the owner's rule for a first-class server's paid tool (ADR 0044). */
export const setSpending = (connectionId: string, change: SpendingChange) =>
  Effect.gen(function* () {
    const { spend } = yield* profileFor(connectionId)
    if (spend === undefined) return yield* new NotFound({ what: `paid tool of ${connectionId}` })
    yield* (yield* Spending).setRule(connectionId, spend.tool, ruleOf(change))
    return yield* spendingView(connectionId)
  })

/**
 * "Approve, and run jobs up to $X without asking" (ADR 0044): the rule for the held call's paid tool, set once the call
 * is decided; its daily total stays as it was, or starts at four times the amount.
 */
export const raiseRule = (connectionId: string, tool: string, runUpTo: string) =>
  Effect.gen(function* () {
    const perJob = microsOf(runUpTo)
    const server = yield* (yield* McpConnections).server(connectionId)
    if (perJob === undefined || profileOf(server.endpoint)?.spend?.tool !== tool) return
    const spending = yield* Spending
    const daily = (yield* spending.rule(connectionId, tool))?.daily ?? perJob * 4
    yield* spending.setRule(connectionId, tool, { perJob, daily })
  })
