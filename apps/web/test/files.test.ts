import { FILE_PATH } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { fileSize, freeName, uploadFolder, uploadName } from '../src/lib/files.ts'

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
