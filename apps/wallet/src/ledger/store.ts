import type {
  ApprovalView,
  LimitView,
  Operation,
  OperationStatus,
  Payment,
  Recipient,
  Terms,
  WalletLimits,
} from '@goblin/wallet/contract'
import {
  addRecipient,
  decidePolicyChange,
  isKnownRecipient,
  type PolicyChange,
  type PolicyDecision,
  policyChanges,
  readViewState,
  recipients,
  recordPolicyChange,
  serviceOverrides,
  setServiceAllowed,
  writeViewState,
} from './book.ts'
import { currentLimits, ledgerLimitViews, toWalletLimits, writeLimits } from './limits.ts'
import {
  activity,
  begin,
  type BeginInput,
  type BeginResult,
  getOperation,
  lookup,
  type LookupResult,
  move,
  type MovePatch,
  type MoveResult,
} from './operations.ts'
import {
  approvalView,
  decide,
  type DecideResult,
  type Decision,
  pendingApprovals,
  reserve,
  type ReserveOptions,
  signing,
  type ReserveOutcome,
} from './reserve.ts'
import { preparedAllowance, putPreparedAllowance, putSignedAllowance, signedAllowances } from './allowances.ts'
import {
  claimFloat,
  endFloatRun,
  type FloatClaim,
  type FloatRunStart,
  type FloatState,
  floatState,
  noteFloatNeed,
  startFloatRun,
} from './float.ts'
import {
  type ChallengeCredential,
  challengeCredential,
  claimChallenge,
  type ClaimResult,
  handOver,
} from './credentials.ts'
import { type Profile, readProfile, updateProfile } from './profile.ts'
import { getQuote, putQuote, type StoredQuote } from './quotes.ts'
import { migrate } from './schema.ts'
import type { Sql } from './sql.ts'
import { getState, isRevoked, putState, REVOKED_KEY } from './state.ts'
import { preparedUpgrade, putPreparedUpgrade } from './upgrades.ts'
import type { Ctx } from './rows.ts'

/**
 * The wallet's ledger over a synchronous SQLite. One store per owner (the Durable Object `idFromName(privyUserId)`).
 * Every method is synchronous, so each is atomic against the others; the multi-statement ones also run in one
 * transaction. Nothing here awaits the network: the spend program does that between calls.
 */
export class LedgerStore {
  readonly #ctx: Ctx

  constructor(sql: Sql, now: () => number = Date.now) {
    this.#ctx = { sql, now }
    migrate(sql)
  }

  limits(): WalletLimits {
    return toWalletLimits(currentLimits(this.#ctx))
  }

  setLimits(input: Omit<WalletLimits, 'version'>): WalletLimits | undefined {
    return this.#ctx.sql.atomic(() => writeLimits(this.#ctx, input))
  }

  limitViews(): LimitView[] {
    return ledgerLimitViews(this.#ctx)
  }

  lookup(id: string, argsHash: string): LookupResult {
    return lookup(this.#ctx, id, argsHash)
  }

  begin(input: BeginInput): BeginResult {
    return begin(this.#ctx, input)
  }

  reserve(id: string, options?: ReserveOptions): ReserveOutcome {
    return reserve(this.#ctx, id, options)
  }

  decide(id: string, decision: Decision): DecideResult {
    return decide(this.#ctx, id, decision)
  }

  approval(id: string): ApprovalView | undefined {
    return approvalView(this.#ctx, id)
  }

  pendingApprovals(): ApprovalView[] {
    return pendingApprovals(this.#ctx)
  }

  operation(id: string): Operation | undefined {
    return getOperation(this.#ctx, id)
  }

  activity(limit = 50): Operation[] {
    return activity(this.#ctx, Math.min(Math.max(limit, 1), 200))
  }

  /** reserved -> signing: the moment before the signer is asked; grant and limits are re-checked here. */
  signing(id: string): MoveResult {
    return signing(this.#ctx, id)
  }

  submitted(id: string, payment: Payment): MoveResult {
    return move(this.#ctx, id, 'submitted', { payment })
  }

  /** Payment confirmed; `delivered` when the paid thing arrived (a paid request answered, a transfer mined). */
  settle(id: string, patch: { payment: Payment; delivery?: MovePatch['delivery']; delivered: boolean }): MoveResult {
    const to: OperationStatus = patch.delivered ? 'delivered' : 'confirmed'
    return move(this.#ctx, id, to, {
      payment: patch.payment,
      ...(patch.delivery === undefined ? {} : { delivery: patch.delivery }),
    })
  }

  /** Failed before money moved: the reservation is released. */
  fail(id: string, reason: string): MoveResult {
    return move(this.#ctx, id, 'failed', { reason })
  }

  /** The outcome is unknown: the reservation stays and nothing retries it. */
  uncertain(id: string, reason: string, payment?: Payment): MoveResult {
    return move(this.#ctx, id, 'uncertain', { reason, ...(payment === undefined ? {} : { payment }) })
  }

  /** `pay_challenge`: binds an MPP challenge to one operation before anything is reserved. */
  claimChallenge(id: string, challengeId: string): ClaimResult {
    return claimChallenge(this.#ctx, id, challengeId)
  }

  /** `pay_challenge`: the signed credential left for the caller; the outcome is unknown and the hold stays. */
  handOver(id: string, reason: string, credential: string): MoveResult {
    return handOver(this.#ctx, id, reason, credential)
  }

  challengeCredential(id: string): ChallengeCredential | undefined {
    return challengeCredential(this.#ctx, id)
  }

  recipients(): Recipient[] {
    return recipients(this.#ctx)
  }

  isKnownRecipient(chain: Terms['chain'], address: string): boolean {
    return isKnownRecipient(this.#ctx, chain, address)
  }

  addRecipient(chain: Terms['chain'], address: string, label: string): void {
    addRecipient(this.#ctx, chain, address, label)
  }

  serviceOverrides(): Record<string, boolean> {
    return Object.fromEntries(serviceOverrides(this.#ctx))
  }

  setServiceAllowed(id: string, allowed: boolean): void {
    setServiceAllowed(this.#ctx, id, allowed)
  }

  recordPolicyChange(id: string, change: string, reason: string, client: string): PolicyChange {
    return recordPolicyChange(this.#ctx, id, change, reason, client)
  }

  policyChanges(): PolicyChange[] {
    return policyChanges(this.#ctx)
  }

  decidePolicyChange(id: string, status: 'applied' | 'dismissed'): PolicyDecision {
    return decidePolicyChange(this.#ctx, id, status)
  }

  viewState(): string {
    return readViewState(this.#ctx)
  }

  putViewState(json: string): boolean {
    return writeViewState(this.#ctx, json)
  }

  profile(): Profile {
    return readProfile(this.#ctx)
  }

  updateProfile(patch: Partial<Profile>): Profile {
    return updateProfile(this.#ctx, patch)
  }

  putPreparedAllowance(hash: string, json: string): void {
    putPreparedAllowance(this.#ctx, hash, json)
  }

  preparedAllowance(hash: string): string | undefined {
    return preparedAllowance(this.#ctx, hash)
  }

  putSignedAllowance(chain: string, json: string): void {
    putSignedAllowance(this.#ctx, chain, json)
  }

  signedAllowances(): { chain: string; json: string }[] {
    return signedAllowances(this.#ctx)
  }

  putPreparedUpgrade(id: string, json: string): void {
    putPreparedUpgrade(this.#ctx, id, json)
  }

  preparedUpgrade(id: string): string | undefined {
    return preparedUpgrade(this.#ctx, id)
  }

  putQuote(stored: StoredQuote): void {
    putQuote(this.#ctx, stored)
  }

  getQuote(id: string, includeExpired = false): StoredQuote | undefined {
    return getQuote(this.#ctx, id, includeExpired)
  }

  /** The Tempo float's refill in flight, if any (ADR 0051). */
  floatState(): FloatState {
    return floatState(this.#ctx)
  }

  /** A trigger's payment the next refill run must fit (decimal USD). */
  noteFloatNeed(need: string): void {
    noteFloatNeed(this.#ctx, need)
  }

  startFloatRun(): FloatRunStart {
    return startFloatRun(this.#ctx)
  }

  /** Claims the single flight for one refill: a new unreserved operation, or the one already in flight. */
  claimFloat(input: { terms: Terms; termsHash: string }): FloatClaim {
    return claimFloat(this.#ctx, input)
  }

  endFloatRun(result: 'sent' | 'failed' | 'idle'): { retryInMs?: number } {
    return endFloatRun(this.#ctx, result)
  }

  isRevoked(): boolean {
    return isRevoked(this.#ctx)
  }

  /**
   * Revokes the wallet: every new spend is refused, pending approvals and unreserved operations are closed. Money
   * already in flight (`signing`, `submitted`, `uncertain`) is left to finish or be reconciled.
   */
  revoke(): void {
    this.#ctx.sql.atomic(() => {
      const now = this.#ctx.now()
      if (getState(this.#ctx, REVOKED_KEY) === undefined) putState(this.#ctx, REVOKED_KEY, String(now))
      this.#ctx.sql.run("UPDATE approvals SET status = 'declined', decided_at_ms = ? WHERE status = 'pending'", now)
      this.#ctx.sql.run(
        "UPDATE operations SET status = 'cancelled', reason = 'The owner revoked this wallet.', updated_at_ms = ? WHERE status IN ('quoted', 'awaiting_approval', 'reserved')",
        now,
      )
    })
  }
}
