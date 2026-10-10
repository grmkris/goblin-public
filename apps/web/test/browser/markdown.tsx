import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LinkConfirmProvider } from '../../src/components/parts/link-confirm.tsx'
import { MessageText } from '../../src/components/parts/text-part.tsx'
import { CODE, MATH } from './markdown-text.ts'
import '../../src/styles.css'

/** A reply with a wide table, which must keep its place when the reply settles. */
const TABLE = [
  '| Plan | Monthly | Requests | Backups | Support | Region | Notes |',
  '| --- | ---: | ---: | --- | --- | --- | --- |',
  '| Starter | $5 | 10M | none | community | one | fine for a hobby project and nothing more |',
  '| Business | $90 | 250M | daily | four-hour response | three | the one to pick once it earns money |',
].join('\n')
const REPLY = ['Here is the comparison.', TABLE, 'And the summary **after** it.'].join('\n\n')

/** Real source components for Markdown behaviour in a browser: code, math, images, links, settling streams. */
function Fixture() {
  const [live, setLive] = useState(true)
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <button type="button" onClick={() => setLive(false)}>
        Finish stream
      </button>
      <section aria-label="Streaming reply">
        <MessageText text={REPLY} live={live} />
      </section>
      <section aria-label="Reply with code">
        <MessageText text={`Use \`groupBy\` like this:\n\n\`\`\`ts\n${CODE}\n\`\`\``} />
      </section>
      <section aria-label="Reply with math">
        <MessageText text={MATH} />
      </section>
      <section aria-label="Reply with a link">
        <MessageText text="Read [the official guide](https://phish.example/login?next=bank) first." />
      </section>
      <section aria-label="Reply with an image">
        <MessageText text="The chart: ![quarterly chart](https://images.example/chart.png?d=secret)" />
      </section>
    </main>
  )
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <LinkConfirmProvider>
      <Fixture />
    </LinkConfirmProvider>,
  )
