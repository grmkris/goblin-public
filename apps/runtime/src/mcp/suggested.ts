// Servers we suggest, each checked by hand to connect from a Worker: by OAuth with dynamic registration, or with no
// sign-in at all. Descriptions are ours, not the servers'. The shelf only adds them; grants still start empty.
import type { ServerSuggestion } from '@goblin/contracts'

export type Stage = 'local' | 'dev' | 'prod' | 'test'

type Suggested = {
  readonly id: string
  readonly title: string
  readonly description: string
  /** The endpoint per stage; one string for every stage. */
  readonly endpoint: string | Readonly<Record<Stage, string>>
  readonly signIn: boolean
}

/** Checked 2026-10-05: stage endpoints follow the wrap-up plan; live acceptance is recorded separately. */
const SUGGESTED: readonly Suggested[] = [
  {
    id: 'myplan',
    title: 'MyPlan',
    description: 'Your notes and canvases. Opens notes as a live editing panel in the chat.',
    endpoint: {
      local: 'https://dev-new.myplan.lol/mcp',
      dev: 'https://dev-new.myplan.lol/mcp',
      test: 'https://myplan.lol/mcp',
      prod: 'https://myplan.lol/mcp',
    },
    signIn: true,
  },
  {
    id: 'mytab',
    title: 'MyTab',
    description: 'Browser sessions on your own machines, for pages that need a real browser.',
    endpoint: {
      local: 'https://dev.mytab.lol/mcp',
      dev: 'https://mytab.lol/mcp',
      test: 'https://mytab.lol/mcp',
      prod: 'https://mytab.lol/mcp',
    },
    signIn: true,
  },
  {
    id: 'mygram',
    title: 'MyGram',
    description: 'Telegram for your agent: messages in, replies out.',
    endpoint: {
      local: 'https://dev.mygram.lol/mcp',
      dev: 'https://dev.mygram.lol/mcp',
      test: 'https://mygram.lol/mcp',
      prod: 'https://mygram.lol/mcp',
    },
    signIn: true,
  },
  {
    id: 'myskills',
    title: 'MySkills',
    description: 'Skill libraries your agent can read and follow.',
    endpoint: {
      local: 'https://dev.myskills.lol/mcp',
      dev: 'https://dev.myskills.lol/mcp',
      test: 'https://myskills.lol/mcp',
      prod: 'https://myskills.lol/mcp',
    },
    signIn: true,
  },
  {
    id: 'deepwiki',
    title: 'DeepWiki',
    description: 'Questions about any public GitHub repository, answered from its generated wiki.',
    endpoint: 'https://mcp.deepwiki.com/mcp',
    signIn: false,
  },
  {
    id: 'context7',
    title: 'Context7',
    description: 'Current documentation and code examples for programming libraries.',
    endpoint: 'https://mcp.context7.com/mcp',
    signIn: false,
  },
  {
    id: 'cloudflare-docs',
    title: 'Cloudflare Docs',
    description: "Search Cloudflare's developer documentation.",
    endpoint: 'https://docs.mcp.cloudflare.com/mcp',
    signIn: false,
  },
]

/** The shelf for `stage`, each entry marked added when one of `endpoints` already serves it. */
export function suggestions(stage: Stage | undefined, endpoints: ReadonlySet<string>): readonly ServerSuggestion[] {
  return SUGGESTED.map(({ endpoint, ...rest }) => {
    const url = typeof endpoint === 'string' ? endpoint : endpoint[stage ?? 'test']
    return { ...rest, endpoint: url, added: endpoints.has(url) }
  })
}
