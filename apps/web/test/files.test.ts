import { FILE_PATH, type FileEntry } from '@goblin/contracts'
import { NotFound, PayloadTooLarge } from '@goblin/contracts/api'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { owner } from '../src/lib/api.ts'
import { fileSize, freeName, uploadAttachment, uploadFolder, uploadName } from '../src/lib/files.ts'
import { messageOf } from '../src/lib/query/app-error.ts'

const DAY = new Date(2026, 9, 6)
const entry = (name: string): FileEntry => ({
  path: `/uploads/2026-10-06/${name}`,
  name,
  kind: 'file',
  size: 7,
  mimeType: 'text/plain',
  updatedAt: 1,
})
const notes = () => new File(['example'], 'notes.txt', { type: 'text/plain' })

/**
 * The files endpoints in memory: today's folder holds `held`, and a write answers `write`. The listing comes through
 * the typed owner client (a URL), the upload through `fetch` itself (a path).
 */
function filesRoutes(held: readonly string[], write: () => Response) {
  const seen: string[] = []
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input, 'http://app.test/')
    const headers = new Headers(init?.headers)
    seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search} csrf=${headers.get('x-goblin-csrf') ?? '-'}`)
    if (url.pathname === '/api/files') return Response.json({ entries: held.map(entry), usedBytes: 0, limitBytes: 1 })
    return write()
  })
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(async () => {
  await owner.runtime.dispose()
})

describe('an upload', () => {
  it('takes a name nobody holds in the day folder and answers the stored file', async () => {
    const seen = filesRoutes(['notes.txt'], () => Response.json(entry('notes (2).txt'), { status: 201 }))
    expect(await uploadAttachment(notes(), new Set(), DAY)).toEqual({
      path: '/uploads/2026-10-06/notes (2).txt',
      name: 'notes (2).txt',
      size: 7,
      mimeType: 'text/plain',
    })
    expect(seen).toEqual([
      'GET /api/files?dir=%2Fuploads%2F2026-10-06 csrf=-',
      'PUT /api/files/content?path=%2Fuploads%2F2026-10-06%2Fnotes%20(2).txt csrf=1',
    ])
  })

  it('fails with the typed refusal its envelope names, quoting its reference', async () => {
    filesRoutes([], () =>
      Response.json(
        { error: { code: 'not_found', message: 'That does not exist.', what: 'x', ref: 'ray-404' } },
        {
          status: 404,
        },
      ),
    )
    const missing = await uploadAttachment(notes(), new Set(), DAY).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(missing).toBeInstanceOf(NotFound)
    expect(messageOf(missing, 'upload notes.txt')).toBe('That does not exist. · ref ray-404')
    filesRoutes([], () =>
      Response.json(
        { error: { code: 'payload_too_large', message: 'That is too large.', limit: 1, ref: 'ray-413' } },
        { status: 413 },
      ),
    )
    const envelope = await uploadAttachment(notes(), new Set(), DAY).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(envelope).toBeInstanceOf(PayloadTooLarge)
    expect(messageOf(envelope, 'upload notes.txt')).toBe('That is too large. · ref ray-413')
  })
})

describe('upload names', () => {
  it('keep what the path rule accepts and replace the rest', () => {
    expect(uploadName('Poročilo (final).pdf')).toBe('Poročilo (final).pdf')
    expect(uploadName('a/b\\c:d?.txt')).toBe('a-b-c-d-.txt')
    expect(uploadName('  tabs\tand  spaces .md ')).toBe('tabs and spaces .md')
    expect(uploadName('..')).toBe('file')
    expect(uploadName('')).toBe('file')
  })
  it('shorten a long name and keep its extension', () => {
    const name = uploadName(`${'x'.repeat(200)}.csv`)
    expect(name).toHaveLength(80)
    expect(name.endsWith('.csv')).toBe(true)
  })
  it('always make a path the runtime accepts', () => {
    for (const raw of ['report.csv', '日本語.txt', '...', 'a'.repeat(300), '<script>.html', 'emoji 🎉.png'])
      expect(FILE_PATH.test(`${uploadFolder(new Date(2026, 9, 6))}/${uploadName(raw)}`)).toBe(true)
  })
})

describe('free names', () => {
  it('number a taken name before its extension', () => {
    expect(freeName('data.csv', new Set())).toBe('data.csv')
    expect(freeName('data.csv', new Set(['data.csv', 'data (2).csv']))).toBe('data (3).csv')
    expect(freeName('notes', new Set(['notes']))).toBe('notes (2)')
  })
})

describe('upload folders and sizes', () => {
  it('name the local day', () => {
    expect(uploadFolder(new Date(2026, 0, 5, 23, 59))).toBe('/uploads/2026-01-05')
  })
  it('read as people do', () => {
    expect(fileSize(512)).toBe('512 B')
    expect(fileSize(2048)).toBe('2 KB')
    expect(fileSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(fileSize(25 * 1024 * 1024)).toBe('25 MB')
  })
})
