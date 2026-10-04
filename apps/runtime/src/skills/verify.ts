// Integrity checks for MCP Skills content. A host acting on a skill keeps the entry it loaded and, before using any
// file, checks it against that entry: only URIs in the retained manifest, exact byte size and SHA-256 digest, and a
// `SKILL.md` whose frontmatter equals the entry's field by field. A digest proves consistency with the server's
// manifest, not trust in the content.
import { parse as parseYaml } from 'yaml'
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, type ManifestFile, type SkillEntry } from './protocol.ts'

export type VerifyFailure =
  | 'dynamic'
  | 'manifest-invalid'
  | 'not-in-manifest'
  | 'size-mismatch'
  | 'digest-mismatch'
  | 'frontmatter-invalid'
  | 'frontmatter-mismatch'
  | 'name-mismatch'

export class SkillVerifyError extends Error {
  readonly failure: VerifyFailure
  constructor(failure: VerifyFailure) {
    super(`skill verification failed: ${failure}`)
    this.failure = failure
  }
}

const SKILL_FILE = 'SKILL.md'

/** `sha256:<hex>` of the bytes. */
export const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** The directory URI of a skill: its `SKILL.md` URI without the file name. */
export const skillRoot = (entry: Pick<SkillEntry, 'uri'>): string => {
  if (!entry.uri.endsWith(`/${SKILL_FILE}`)) throw new SkillVerifyError('manifest-invalid')
  return entry.uri.slice(0, -SKILL_FILE.length - 1)
}

/**
 * The manifest a host can act on: a list (generated `"dynamic"` content is declined), within the spec's bounds,
 * containing the `SKILL.md`, every file under the skill's own directory, no URI twice, and a `SKILL.md` whose
 * directory is named after the skill.
 */
export const usableManifest = (entry: SkillEntry): readonly ManifestFile[] => {
  if (entry.resources === 'dynamic') throw new SkillVerifyError('dynamic')
  const files = entry.resources
  const root = skillRoot(entry)
  const total = files.reduce((sum, file) => sum + file.size, 0)
  const uris = new Set(files.map((file) => file.uri))
  if (
    files.length > MAX_SKILL_FILES ||
    total > MAX_SKILL_BYTES ||
    uris.size !== files.length ||
    !uris.has(entry.uri) ||
    files.some((file) => !file.uri.startsWith(`${root}/`))
  )
    throw new SkillVerifyError('manifest-invalid')
  const name = entry.frontmatter['name']
  if (typeof name !== 'string' || root.split('/').at(-1) !== name) throw new SkillVerifyError('name-mismatch')
  return files
}

/**
 * The manifest file a skill-relative path names. Relative references resolve against the skill's root; anything that
 * climbs out of it, or is not in the retained manifest, is refused.
 */
export const fileAt = (entry: SkillEntry, path: string): ManifestFile => {
  const segments = path.replace(/^\.\//u, '').split('/')
  if (path === '' || path.startsWith('/') || segments.some((part) => part === '' || part === '.' || part === '..'))
    throw new SkillVerifyError('not-in-manifest')
  const uri = `${skillRoot(entry)}/${segments.join('/')}`
  const file = usableManifest(entry).find((item) => item.uri === uri)
  if (file === undefined) throw new SkillVerifyError('not-in-manifest')
  return file
}

/** Raw bytes must have exactly the manifest's size and digest. */
export const verifyBytes = async (file: ManifestFile, bytes: Uint8Array): Promise<void> => {
  if (bytes.byteLength !== file.size) throw new SkillVerifyError('size-mismatch')
  if ((await digestOf(bytes)) !== file.digest) throw new SkillVerifyError('digest-mismatch')
}

/** Canonical JSON: object keys sorted, so two parses compare by value. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/**
 * Split a `SKILL.md` into its YAML frontmatter and body, and check the frontmatter equals the entry's: same fields,
 * same values, with `name` and `description` present.
 */
export const verifySkillFile = (entry: SkillEntry, text: string): { readonly body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text)
  if (match === null) throw new SkillVerifyError('frontmatter-invalid')
  let parsed: unknown
  try {
    parsed = parseYaml(match[1] ?? '')
  } catch {
    throw new SkillVerifyError('frontmatter-invalid')
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('name' in parsed) ||
    !('description' in parsed)
  )
    throw new SkillVerifyError('frontmatter-invalid')
  if (canonical(parsed) !== canonical(entry.frontmatter)) throw new SkillVerifyError('frontmatter-mismatch')
  return { body: text.slice(match[0].length) }
}

/** The bytes a `resources/read` content block carries: text as UTF-8, a blob decoded from base64. */
export const contentBytes = (content: { readonly text?: string; readonly blob?: string }): Uint8Array => {
  if (typeof content.text === 'string') return new TextEncoder().encode(content.text)
  if (typeof content.blob === 'string') return Uint8Array.from(atob(content.blob), (char) => char.charCodeAt(0))
  throw new SkillVerifyError('size-mismatch')
}
