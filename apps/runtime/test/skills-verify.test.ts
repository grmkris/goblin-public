import { describe, expect, it } from 'vitest'
import type { SkillEntry } from '../src/skills/protocol.ts'
import {
  SkillVerifyError,
  contentBytes,
  digestOf,
  fileAt,
  usableManifest,
  verifyBytes,
  verifySkillFile,
} from '../src/skills/verify.ts'

const SKILL = "---\nname: code-review\ndescription: Review code using the team's checklist.\n---\n\n# Code review\n"
const CHECKLIST = '# Review checklist\n'
const bytes = (text: string) => new TextEncoder().encode(text)

const entry = async (overrides: Partial<SkillEntry> = {}): Promise<SkillEntry> => ({
  uri: 'skill://v1/code-review/SKILL.md',
  frontmatter: { name: 'code-review', description: "Review code using the team's checklist." },
  resources: [
    { uri: 'skill://v1/code-review/SKILL.md', digest: await digestOf(bytes(SKILL)), size: bytes(SKILL).byteLength },
    {
      uri: 'skill://v1/code-review/references/checklist.md',
      digest: await digestOf(bytes(CHECKLIST)),
      size: bytes(CHECKLIST).byteLength,
    },
  ],
  ...overrides,
})

const failure = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    return error instanceof SkillVerifyError ? error.failure : 'other'
  }
  return 'none'
}
const failureAsync = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    return error instanceof SkillVerifyError ? error.failure : 'other'
  }
  return 'none'
}

describe('skill verification', () => {
  it('matches the spec example digest', async () => {
    // The MCP Skills overview's example SKILL.md and its published digest.
    const example =
      "---\nname: code-review\ndescription: Review code using the team's checklist.\n---\n\n# Code review\n\nRead `references/checklist.md`, then review the diff.\n"
    expect(await digestOf(bytes(example))).toBe(
      'sha256:d2489d6c182e8df9c178563ff9f2eac7998a0c1bb1278c52a7fd5306e4259160',
    )
  })

  it('accepts exact bytes and rejects a changed size or digest', async () => {
    const skill = await entry()
    const [main] = usableManifest(skill)
    if (main === undefined) throw new Error('fixture')
    await expect(verifyBytes(main, bytes(SKILL))).resolves.toBeUndefined()
    expect(await failureAsync(() => verifyBytes(main, bytes(`${SKILL} `)))).toBe('size-mismatch')
    expect(await failureAsync(() => verifyBytes(main, bytes(SKILL.replace('Code', 'Cods'))))).toBe('digest-mismatch')
  })

  it('compares frontmatter field by field and returns the body', async () => {
    const skill = await entry()
    expect(verifySkillFile(skill, SKILL).body).toBe('\n# Code review\n')
    expect(failure(() => verifySkillFile(skill, SKILL.replace('checklist.', 'list.')))).toBe('frontmatter-mismatch')
    expect(failure(() => verifySkillFile(skill, '# no frontmatter\n'))).toBe('frontmatter-invalid')
    const extra = await entry({
      frontmatter: { description: "Review code using the team's checklist.", name: 'code-review', license: 'MIT' },
    })
    expect(failure(() => verifySkillFile(extra, SKILL))).toBe('frontmatter-mismatch')
  })

  it('treats key order as irrelevant', async () => {
    const skill = await entry({
      frontmatter: { description: "Review code using the team's checklist.", name: 'code-review' },
    })
    expect(verifySkillFile(skill, SKILL).body).toBe('\n# Code review\n')
  })

  it('resolves only paths inside the retained manifest', async () => {
    const skill = await entry()
    expect(fileAt(skill, 'references/checklist.md').size).toBe(bytes(CHECKLIST).byteLength)
    expect(fileAt(skill, './references/checklist.md').uri).toBe('skill://v1/code-review/references/checklist.md')
    expect(failure(() => fileAt(skill, '../other/SKILL.md'))).toBe('not-in-manifest')
    expect(failure(() => fileAt(skill, '/etc/passwd'))).toBe('not-in-manifest')
    expect(failure(() => fileAt(skill, 'references/new.md'))).toBe('not-in-manifest')
  })

  it('declines dynamic skills and malformed manifests', async () => {
    expect(
      failure(() => usableManifest({ uri: 'skill://x/a/SKILL.md', frontmatter: { name: 'a' }, resources: 'dynamic' })),
    ).toBe('dynamic')
    const skill = await entry()
    const files = skill.resources
    if (files === 'dynamic') throw new Error('fixture')
    const outside = [...files, { uri: 'skill://v1/other/x.md', digest: files[0]?.digest ?? '', size: 1 }]
    expect(failure(() => usableManifest({ ...skill, resources: outside }))).toBe('manifest-invalid')
    expect(failure(() => usableManifest({ ...skill, resources: files.slice(1) }))).toBe('manifest-invalid')
    expect(failure(() => usableManifest({ ...skill, frontmatter: { name: 'other', description: 'x' } }))).toBe(
      'name-mismatch',
    )
  })

  it('reads text and base64 blobs as bytes', () => {
    expect(contentBytes({ text: 'é' })).toEqual(new Uint8Array([0xc3, 0xa9]))
    expect(contentBytes({ blob: btoa('hi') })).toEqual(bytes('hi'))
  })
})
