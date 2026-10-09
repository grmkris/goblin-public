import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Button,
  ComposerInput,
  Input,
  NativeSelect,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireInput,
  QuestionnaireActions,
  QuestionnaireNext,
  Textarea,
  Card,
  CardContent,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@goblin/ui'
import { MessageComposer } from '../../src/components/composer.tsx'
import { LinkOffer } from '../../src/components/apps/offers.tsx'
import '../../src/styles.css'

function Fields() {
  return (
    <main className="p-6">
      <Input id="input" aria-label="Input" />
      <Input id="code" variant="code" aria-label="Code" defaultValue="123456" />
      <Textarea id="textarea" aria-label="Textarea" />
      <ComposerInput id="composer" aria-label="Composer" />
      <NativeSelect id="select" aria-label="Select">
        <option>Server</option>
      </NativeSelect>
      <Questionnaire>
        <QuestionnaireItem name="q">
          <QuestionnaireInput id="questionnaire" aria-label="Question" />
        </QuestionnaireItem>
        <QuestionnaireActions>
          <QuestionnaireNext />
        </QuestionnaireActions>
      </Questionnaire>
      <Input id="rename" variant="pill" aria-label="Rename" />
    </main>
  )
}

function Attachments() {
  const [sent, setSent] = useState(0)
  return (
    <main className="p-6">
      <MessageComposer
        conversation="1"
        running={false}
        onStop={() => undefined}
        onNewThread={() => undefined}
        onSend={async () => {
          setSent((n) => n + 1)
          return true
        }}
        attach
      />
      <output aria-label="Sent">{sent}</output>
    </main>
  )
}

function Styles() {
  return (
    <main className="p-6 w-full">
      <nav className="shell-sidebar" style={{ width: 264 }}>
        <ul className="sidebar-rows">
          <li>
            <a className="sidebar-row" href="#personal" data-sample="tree">
              <span className="sidebar-row-name">Personal</span>
            </a>
          </li>
          <li>
            <a className="sidebar-row" href="#japan" aria-current="page" data-sample="nested">
              <span className="sidebar-row-name">Japan</span>
            </a>
          </li>
          <li>
            <a className="sidebar-row" href="#taxes" data-unread data-sample="closed">
              <span className="sidebar-row-name">Taxes</span>
            </a>
          </li>
        </ul>
      </nav>
      <div className="app-stage" data-mode="inline" style={{ position: 'relative', height: 140 }}>
        <LinkOffer link={new URL('https://example.com')} serverId="Example" onDone={() => undefined} />
      </div>
      <div className="composer-context">
        <Button variant="ghost" size="model" aria-label="Model: Example" data-sample="model">
          Model
        </Button>
      </div>
      <Input variant="pill" data-sample="rename" aria-label="Rename" />
      <a className="apps-card" href="#card">
        <Card interactive data-sample="interactive-card">
          <CardContent>App card</CardContent>
        </Card>
      </a>
      <Reasoning>
        <ReasoningTrigger>Thoughts</ReasoningTrigger>
        <ReasoningContent>These thoughts should actually close.</ReasoningContent>
      </Reasoning>
    </main>
  )
}

const mode = new URLSearchParams(location.search).get('mode')
const root = document.getElementById('root')
if (root)
  createRoot(root).render(mode === 'attachments' ? <Attachments /> : mode === 'styles' ? <Styles /> : <Fields />)
