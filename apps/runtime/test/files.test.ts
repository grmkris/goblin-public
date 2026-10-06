import { describe, expect, it } from 'vitest'
import { fileDirectory, filePath, mayWrite } from '../src/files/store.ts'
import { Forbidden } from '../src/http/errors.ts'

describe("the owner's file paths", () => {
  it('accept the two areas and plain paths under them', () => {
    expect(fileDirectory('/uploads')).toBe('/uploads')
    expect(fileDirectory('/agent/reports')).toBe('/agent/reports')
    expect(filePath('/uploads/sales.csv')).toBe('/uploads/sales.csv')
  })
  it('refuse anything that could leave them', () => {
    expect(() => filePath('/uploads/../agent/x')).toThrow()
    expect(() => filePath('/agent')).toThrow()
    expect(() => fileDirectory('/')).toThrow()
    expect(() => fileDirectory('/etc')).toThrow()
  })
})

describe('who writes where', () => {
  it('lets the agent write only under /agent, and the owner anywhere', () => {
    expect(() => mayWrite('agent', '/agent/report.md')).not.toThrow()
    expect(() => mayWrite('agent', '/uploads/sales.csv')).toThrow(Forbidden)
    expect(() => mayWrite('owner', '/uploads/sales.csv')).not.toThrow()
  })
})
