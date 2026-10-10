import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Diagram } from '@goblin/kit/diagram'
import { MessageText } from '../../src/components/parts/text-part.tsx'
import { checkDiagramSafety } from './diagram-safety.ts'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

const flow = 'graph LR\n A[Draft] -->|submit| B[Review]\n B --> C[Ship]\n D[Unrelated]'
const families = [
  flow,
  'sequenceDiagram\n participant A as Alice\n participant B as Bob\n A->>B: Hello\n B->>A: Reply',
  'classDiagram\n Animal <|-- Dog\n class Animal {\n +name: String\n }',
  'erDiagram\n PERSON ||--o{ ORDER : places',
  'stateDiagram-v2\n [*] --> Idle\n Idle --> Running',
  'xychart-beta\n x-axis [Jan, Feb]\n y-axis 0 --> 10\n bar [3, 7]',
]

function Fixture() {
  const [safety, setSafety] = useState<string[]>([])
  const [visible, setVisible] = useState(true)
  const [live, setLive] = useState(true)
  useEffect(() => setSafety(checkDiagramSafety()), [])
  return (
    <main className="p-6 mx-auto max-w-3xl">
      <button type="button" onClick={() => setVisible((value) => !value)}>
        Toggle diagrams
      </button>
      <button type="button" onClick={() => document.documentElement.classList.toggle('dark')}>
        Toggle theme
      </button>
      <button type="button" onClick={() => setLive(false)}>
        Finish stream
      </button>
      <svg aria-label="Outside SVG" width="40" height="30">
        <text x="0" y="20">
          X
        </text>
      </svg>
      {visible &&
        families.map((source, index) => (
          <section key={source} aria-label={`Diagram ${index}`}>
            <MessageText text={`\`\`\`mermaid\n${source}\n\`\`\``} />
          </section>
        ))}
      <section aria-label="Inert diagram">
        <Diagram source={flow} fallback="fallback" interactive={false} />
      </section>
      <section aria-label="Invalid diagram">
        <MessageText text={'```mermaid\nnot a diagram\n```'} />
      </section>
      <section aria-label="Streaming diagram">
        <MessageText text={`\`\`\`mermaid\n${flow}${live ? '' : '\n```'}`} live={live} />
      </section>
      <output aria-label="SVG safety checks">{JSON.stringify(safety)}</output>
    </main>
  )
}
const root = document.getElementById('root')
if (root === null) throw new Error('fixture root missing')
createRoot(root).render(withQueryClient(<Fixture />))
