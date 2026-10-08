import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Button,
  Composer,
  ComposerActions,
  ComposerInput,
  Drawer,
  DrawerContent,
  DrawerTitle,
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
  SidebarMenuButton,
  SidebarProvider,
} from '@goblin/ui'
import { HomeNoteReader } from '../../src/components/home/note-reader.tsx'
import { useDockInsets } from '../../src/components/use-conversation.ts'
import { CHAT_SNAPS, HALF_CHAT, useChatSnap } from '../../src/components/use-chat-snap.ts'
import { MessageComposer } from '../../src/components/composer.tsx'
import { HomeFeedback } from '../../src/components/home/feedback.ts'
import { PaneHeader } from '../../src/components/pane-header.tsx'
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

function KeyboardDrawer() {
  const [open, setOpen] = useState(true)
  const { snap, setSnap, keyboardInset } = useChatSnap(open)
  const pane = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(pane, dock)
  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      snapPoints={CHAT_SNAPS}
      snapPoint={snap ?? HALF_CHAT}
      onSnapPointChange={setSnap}
    >
      <DrawerContent snapping data-keyboard={keyboardInset > 0 || undefined}>
        <DrawerTitle className="sr-only">Chat</DrawerTitle>
        <div className="chat-sheet-body">
          <div className="workspace-pane-host">
            <section className="chat-pane conversation-pane" ref={pane} data-snap={snap}>
              <div className="chat-dock" ref={dock}>
                <div className="dock-cards">
                  {Array.from({ length: 8 }, (_, n) => (
                    <p key={n}>Question {n + 1}</p>
                  ))}
                </div>
                <div className="dock-composer">
                  <Composer>
                    <ComposerInput aria-label="Message" defaultValue={'One\nTwo\nThree'} />
                    <ComposerActions>
                      <Button>Send</Button>
                    </ComposerActions>
                  </Composer>
                </div>
              </div>
            </section>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function Note() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        Read more
      </Button>
      <HomeNoteReader
        open={open}
        onOpenChange={setOpen}
        returnFocus={trigger.current}
        tile={{
          kind: 'note',
          id: 'note',
          title: 'Long note',
          size: 'small',
          placedBy: 'owner',
          markdown: Array.from(
            { length: 30 },
            (_, n) => `Paragraph ${n + 1}. **Full content** with a [safe link](https://example.com).`,
          ).join('\n\n'),
        }}
      />
    </>
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

function Feedback() {
  const root = useRef<HTMLElement>(null)
  const feedback = useRef<HomeFeedback>(undefined)
  useEffect(() => {
    if (root.current === null) return
    const current = new HomeFeedback(root.current)
    feedback.current = current
    return () => current.dispose()
  }, [])
  return (
    <section className="home-surface p-6" ref={root}>
      <Button onClick={() => feedback.current?.highlight(['note'])}>Show tile</Button>
      <Button onClick={() => feedback.current?.remove(['note', 'app'])}>Remove tiles</Button>
      <Button onClick={() => feedback.current?.dispose()}>Dispose feedback</Button>
      <div className="home-grid">
        <article className="home-tile" data-home-tile="note" data-kind="note" data-size="medium">
          <p id="note-title">A note</p>
          <Button>Read more</Button>
        </article>
        <article className="home-tile" data-home-tile="app" data-kind="app" data-size="medium">
          <iframe title="Resident app" srcDoc="<p>Resident app</p>" />
        </article>
      </div>
    </section>
  )
}

function Styles() {
  return (
    <SidebarProvider>
      <main className="p-6 w-full">
        <div className="tree-row">
          <SidebarMenuButton size="tree" data-sample="tree">
            Main
          </SidebarMenuButton>
        </div>
        <div data-slot="sidebar-menu-sub">
          <div className="tree-row">
            <SidebarMenuButton size="tree-nested" data-sample="nested">
              Thread
            </SidebarMenuButton>
          </div>
        </div>
        <div className="tree-row" data-closed="true">
          <SidebarMenuButton size="tree-closed" data-sample="closed">
            Closed
          </SidebarMenuButton>
        </div>
        <div className="workspace-pane" style={{ position: 'relative', height: 96 }} data-focused="true">
          <PaneHeader item="c:1" title="Main" first onClose={() => undefined} />
        </div>
        <div className="home-surface">
          <div className="home-header-actions">
            <Button variant="ghost" size="home-action" data-sample="home-action">
              Ask for a tile
            </Button>
          </div>
          <div className="app-stage" data-mode="home" style={{ position: 'relative', height: 140 }}>
            <LinkOffer link={new URL('https://example.com')} serverId="Example" onDone={() => undefined} />
          </div>
        </div>
        <div className="composer-context">
          <Button variant="ghost" size="model" aria-label="Model: Example" data-sample="model">
            Model
          </Button>
        </div>
        <Input variant="pill" className="pane-rename" data-sample="rename" aria-label="Rename" />
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
    </SidebarProvider>
  )
}

const mode = new URLSearchParams(location.search).get('mode')
const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    mode === 'keyboard' ? (
      <KeyboardDrawer />
    ) : mode === 'note' ? (
      <Note />
    ) : mode === 'attachments' ? (
      <Attachments />
    ) : mode === 'feedback' ? (
      <Feedback />
    ) : mode === 'styles' ? (
      <Styles />
    ) : (
      <Fields />
    ),
  )
