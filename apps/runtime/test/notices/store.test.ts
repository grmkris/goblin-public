import { afterEach, describe, expect, it } from 'vitest'
import { NOTICE_CAP, NOTICE_WINDOW, type NewNotice, NoticeStore } from '../../src/notices/store.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

const store = () => {
  const database = chatDatabase()
  open.push(database)
  return new NoticeStore(durable(database.db))
}

const T = 1_800_000_000_000
const notice = (id: string, at: number, routineId = 'rt_1'): NewNotice => ({
  id,
  routineId,
  source: 'event',
  chatId: '1',
  entryRequestId: id,
  connectionId: 'sidequest',
  label: 'Sidequest',
  title: id,
  body: null,
  url: null,
  at,
  createdAt: at,
})

describe('notices and their hour (ADR 0041)', () => {
  it('keeps a notice once, so a replayed delivery posts nothing again', () => {
    const notices = store()
    expect(notices.claim(notice('n1', T), true)).toEqual({ posted: true })
    expect(notices.claim(notice('n1', T), true)).toEqual({ posted: false })
    expect(notices.unwritten().map((row) => row.id)).toEqual(['n1'])
    notices.written('n1', T + 1)
    expect(notices.unwritten()).toEqual([])
  })

  it('posts twenty an hour, keeps the rest for Activity only, and owes their digest when the next hour starts', () => {
    const notices = store()
    for (let index = 0; index < NOTICE_CAP + 5; index++) notices.claim(notice(`n${String(index)}`, T + index), true)
    // The five past the cap are kept as written (no chat entry), so Activity lists them, with no Telegram copy.
    const folded = notices.recent(0, 100)
    expect(folded.map((row) => row.id)).toEqual(['n24', 'n23', 'n22', 'n21', 'n20'])
    expect(folded.every((row) => row.telegramState === 'none')).toBe(true)
    expect(notices.unwritten()).toHaveLength(NOTICE_CAP)
    expect(notices.claim(notice('next', T + NOTICE_WINDOW + 1), true)).toEqual({
      posted: true,
      digest: { routineId: 'rt_1', startedAt: T, folded: 5 },
    })
  })

  it('owes a digest from the sweep when no event starts the next hour, once', () => {
    const notices = store()
    for (let index = 0; index < NOTICE_CAP + 2; index++) notices.claim(notice(`n${String(index)}`, T + index), true)
    expect(notices.digestsDue(T + NOTICE_WINDOW - 1)).toEqual([])
    expect(notices.digestsDue(T + NOTICE_WINDOW)).toEqual([{ routineId: 'rt_1', startedAt: T, folded: 2 }])
    expect(notices.digestsDue(T + NOTICE_WINDOW)).toEqual([])
  })

  it('does not count reminders, answers and digests into the hour', () => {
    const notices = store()
    for (let index = 0; index < NOTICE_CAP; index++) notices.claim(notice(`n${String(index)}`, T + index), true)
    expect(notices.claim({ ...notice('reminder', T + 50), source: 'reminder' }, false)).toEqual({ posted: true })
    expect(notices.claim(notice('one-more', T + 60), true)).toEqual({ posted: false, folded: true })
  })

  it('lists written notices newest first, marks them read, and forgets old ones', () => {
    const notices = store()
    for (const [id, at] of [
      ['old', T],
      ['new', T + 10],
    ] as const) {
      notices.claim(notice(id, at, `rt_${id}`), true)
      notices.written(id, at)
    }
    expect(notices.recent(0, 10).map((row) => row.id)).toEqual(['new', 'old'])
    notices.read(['new'], T + 20)
    expect(notices.get('new')?.readAt).toBe(T + 20)
    notices.prune(T + 5)
    expect(notices.recent(0, 10).map((row) => row.id)).toEqual(['new'])
  })

  it('keeps a Telegram copy pending only for a notice that has one', () => {
    const notices = store()
    notices.claim({ ...notice('quiet', T), routineId: 'a' }, true)
    notices.claim({ ...notice('loud', T), routineId: 'b', telegramText: 'Sidequest: loud' }, true)
    expect([notices.get('quiet')?.telegramState, notices.get('loud')?.telegramState]).toEqual(['none', 'pending'])
  })
})
