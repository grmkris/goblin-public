import { describe, expect, it } from 'vitest'
import { downloadOf } from '../src/lib/app-download.ts'

const resource = (fields: Record<string, unknown>) => [
  { type: 'resource', resource: { uri: 'file:///x.txt', ...fields } },
]

describe('a file an App offers to save', () => {
  it('takes text or base64 bytes, with a safe name and a plain type', () => {
    expect(downloadOf(resource({ uri: 'file:///out/report 1.csv', mimeType: 'text/csv', text: 'a,b' }))).toEqual({
      name: 'report 1.csv',
      type: 'text/csv',
      bytes: new TextEncoder().encode('a,b'),
    })
    expect(downloadOf(resource({ blob: btoa('hi'), mimeType: 'text/html; charset=utf-8' }))).toMatchObject({
      name: 'x.txt',
      type: 'application/octet-stream',
      bytes: new Uint8Array([104, 105]),
    })
    expect(downloadOf(resource({ uri: 'file:///..%2F..%2F.env', text: 'k' }))?.name).toBe('_.._.env')
  })
  it('offers nothing for a link, bad base64, or more than 5 MiB', () => {
    expect(downloadOf([{ type: 'resource_link', uri: 'https://example.com/x.csv', name: 'x.csv' }])).toBeUndefined()
    expect(downloadOf(resource({ blob: '%%%' }))).toBeUndefined()
    expect(downloadOf(resource({ text: 'x'.repeat(5 * 1024 * 1024 + 1) }))).toBeUndefined()
  })
})
