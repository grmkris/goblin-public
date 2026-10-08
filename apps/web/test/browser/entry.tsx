import { useRef, useState } from 'react'
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
} from '@goblin/ui'
import { HomeNoteReader } from '../../src/components/home/note-reader.tsx'
import { useDockInsets } from '../../src/components/use-conversation.ts'
import { CHAT_SNAPS, HALF_CHAT, useChatSnap } from '../../src/components/use-chat-snap.ts'
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

const mode = new URLSearchParams(location.search).get('mode')
const root = document.getElementById('root')
if (root) createRoot(root).render(mode === 'keyboard' ? <KeyboardDrawer /> : mode === 'note' ? <Note /> : <Fields />)
