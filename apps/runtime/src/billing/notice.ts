/**
 * The agent's side of the subscription renewals' notices (ADR 0054): the Worker's cron tells the owner a renewal is
 * near, a payment went through, failed or that Pro ended, through `/internal/billing-notice`. Each is posted once per
 * id in Personal (Activity lists it) and, when the owner has Telegram, copied there; the words are goblin's own.
 */
import { PERSONAL_TOPIC } from '@goblin/contracts'
import type { BillingNotice } from '@goblin/contracts/internal'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { Conversations } from '../chats/service.ts'
import { Notices } from '../notices/service.ts'
import { writeNotice } from '../routines/notices.ts'

/** The notices' label and their routine key: the plan's own, never a routine of the owner's. */
const LABEL = 'goblin Pro'
const ROUTINE = 'billing'

export const postBillingNotice = Effect.fn('billing.notice')(function* (notice: BillingNotice) {
  const home = yield* (yield* Conversations).routineHome(PERSONAL_TOPIC)
  const now = yield* Clock.currentTimeMillis
  const telegram = [`${LABEL}: ${notice.title}`, notice.body, notice.url].filter((part) => part !== undefined)
  const claim = yield* (yield* Notices).claim(
    {
      id: notice.id,
      routineId: ROUTINE,
      source: 'event',
      chatId: home.chat,
      entryRequestId: notice.id,
      connectionId: null,
      label: LABEL,
      title: notice.title,
      body: notice.body ?? null,
      url: notice.url ?? null,
      at: now,
      createdAt: now,
      telegramText: telegram.join('\n'),
    },
    false,
  )
  if (claim.posted) yield* writeNotice(notice.id)
})
