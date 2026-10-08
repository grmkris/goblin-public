import { SpikeError, type Overlay, type Published } from './overlay.ts'
import { bounded } from './lsp.ts'
import * as Schema from 'effect/Schema'

const Tree = Schema.Struct({ tree: Schema.Array(Schema.Struct({ path: Schema.String, mode: Schema.String })) })

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SpikeError('github_response')
  // SAFETY: JSON objects passed this object and array check; fields remain unknown until individually decoded.
  return value as Record<string, unknown>
}
const field = (value: unknown, key: string): string => {
  const result = object(value)[key]
  if (typeof result !== 'string') throw new SpikeError('github_response')
  return result
}

/** Publishing stays in the trusted host. Neither agent tools nor verifier processes receive GitHub credentials. */
export class GitHub {
  constructor(
    readonly repo: string,
    readonly gh: string,
  ) {
    if (repo !== 'grmkris/goblin') throw new SpikeError('repo_not_allowlisted')
  }

  async api(route: string, body?: unknown): Promise<unknown> {
    const child = Bun.spawn(
      [
        this.gh,
        'api',
        `/repos/${this.repo}/${route}`,
        ...(body === undefined ? [] : ['--method', 'POST', '--input', '-']),
      ],
      {
        stdin: body === undefined ? 'ignore' : new Blob([JSON.stringify(body)]),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const work = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    let result: Awaited<typeof work>
    try {
      result = await bounded(work, 20_000)
    } catch (error) {
      child.kill()
      throw error
    }
    const [text, , code] = result
    if (code !== 0) throw new SpikeError('github_request_failed')
    return JSON.parse(text)
  }

  async publish(overlay: Overlay, title: string, body: string, persist: () => void): Promise<Published> {
    const revision = overlay.revision
    overlay.assertReady(revision)
    const branch = `goblin-spike/${overlay.id}`
    const existing = await this.api(`pulls?state=all&head=grmkris:${branch}`)
    if (Array.isArray(existing) && existing[0]) {
      const receipt = this.receipt(existing[0], revision)
      if (receipt.commit !== overlay.publication?.commit) throw new SpikeError('publication_conflict')
      return receipt
    }
    const base = await this.api(`git/commits/${overlay.base}`)
    const baseTree = field(object(base)['tree'], 'sha')
    const original = Schema.decodeUnknownSync(Tree)(await this.api(`git/trees/${baseTree}?recursive=1`))
    const modes = new Map(original.tree.map((entry) => [entry.path, entry.mode]))
    const tree = await this.api('git/trees', {
      base_tree: baseTree,
      tree: [...overlay.changes].map(([file, content]) => ({
        path: file,
        mode: modes.get(file) ?? '100644',
        type: 'blob',
        content,
      })),
    })
    const sha =
      overlay.publication?.commit ??
      field(
        await this.api('git/commits', {
          message: title,
          tree: field(tree, 'sha'),
          parents: [overlay.base],
        }),
        'sha',
      )
    if (overlay.publication?.commit === undefined) {
      overlay.publication = { title, body, commit: sha }
      persist()
    }
    const ref = await this.ref(branch)
    if (ref !== undefined && ref !== sha) throw new SpikeError('publication_conflict')
    if (ref === undefined) await this.api('git/refs', { ref: `refs/heads/${branch}`, sha })
    const result = await this.api('pulls', {
      title,
      head: branch,
      base: 'main',
      draft: true,
      body: `${body}\n\nValidation: in-memory TypeScript and Effect checks, type-aware Oxlint, and formatting.\nChecked revision: \`${revision}\`. Base: \`${overlay.base}\`.\nThis spike does not prove full tests, builds, or deployment.`,
    })
    const receipt = this.receipt(result, sha)
    if (receipt.commit !== sha) throw new SpikeError('publication_conflict')
    return receipt
  }

  private async ref(branch: string): Promise<string | undefined> {
    try {
      const value = object(await this.api(`git/ref/heads/${branch}`))
      return field(value['object'], 'sha')
    } catch {
      return undefined
    }
  }

  private receipt(value: unknown, commit: string): Published {
    const number = object(value)['number']
    if (typeof number !== 'number') throw new SpikeError('github_response')
    const head = object(value)['head']
    const headSha = head === undefined ? commit : field(head, 'sha')
    return { url: field(value, 'html_url'), number, commit: headSha }
  }
}
