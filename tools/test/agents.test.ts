import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { checkSkills, markdownLinks } from '../agents.ts'

const owned: string[] = []
afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const fixture = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goblin-skill-proof-'))
  owned.push(root)
  mkdirSync(path.join(root, '.agents/skills/x'), { recursive: true })
  return root
}

const source = '---\nname: x\ndescription: Apply the reviewed fixture skill when checking provenance.\n---\nBody\n'
test('changed vendor bytes fail even when SKILL.md is unchanged', () => {
  const root = fixture()
  const dir = path.join(root, '.agents/skills/x')
  writeFileSync(path.join(dir, 'SKILL.md'), source)
  writeFileSync(path.join(dir, 'LICENSE'), 'license')
  writeFileSync(path.join(dir, 'reference.md'), 'changed')
  writeFileSync(
    path.join(root, '.agents/skills/sources.json'),
    JSON.stringify({
      version: 1,
      reviewedAt: '2026-10-04',
      skills: {
        x: {
          repository: 'fixture/skills',
          commit: 'a'.repeat(40),
          path: 'x',
          sourceSha256: createHash('sha256').update(source).digest('hex'),
          licenses: ['LICENSE'],
          unchanged: true,
          adaptation: 'Fixture skill copied unchanged.',
          copiedFileHashes: { 'reference.md': createHash('sha256').update('original').digest('hex') },
        },
      },
    }),
  )
  expect(checkSkills(root).some((failure) => failure.includes('reference.md differs'))).toBe(true)
})

test('wrong skill name/folder fails', () => {
  const root = fixture()
  writeFileSync(path.join(root, '.agents/skills/x/SKILL.md'), source.replace('name: x', 'name: y'))
  expect(checkSkills(root).some((failure) => failure.includes('folder name'))).toBe(true)
})

test('link scanner ignores code and external URLs', () => {
  expect(markdownLinks('[local](a.md) `x [ignored](b.md)` [external](https://example.com)')).toEqual(['a.md'])
})
