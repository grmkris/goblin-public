import { App } from '@modelcontextprotocol/ext-apps'

/** SDK-connected browser fixture. Its count is lost on frame reload, making placement continuity observable. */
const app = new App({ name: 'fixture-board', version: '1' }, {}, { autoResize: false })
const element = (id: string) => {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`Missing fixture element ${id}`)
  return found
}
/** A host request that failed shows as `failed` in the result line, where the acceptance run reads it. */
const reportFailure = () => {
  element('result').textContent = 'failed'
}
let count = 0
let mode = 'unknown'
const render = () => {
  element('out').textContent = `count ${count} · mode ${mode}`
  document.body.dataset.count = String(count)
  document.body.dataset.mode = mode
}
app.addEventListener('hostcontextchanged', (context) => {
  if (context.displayMode) mode = context.displayMode
  render()
})
app.addEventListener('toolresult', (result) => {
  const text = result.content?.find((block) => block.type === 'text')
  if (text !== undefined && 'text' in text) element('result').textContent = text.text
})
element('inc').addEventListener('click', () => {
  count += 1
  render()
})
/** Asks the host for a display mode and shows the one it granted. */
const display = async (wanted: 'fullscreen' | 'inline') => {
  mode = (await app.requestDisplayMode({ mode: wanted })).mode
  render()
}
/** Calls a tool of another server, which the host must refuse. */
const callOther = async () => {
  try {
    const result = await app.callServerTool({ name: 'board', arguments: { connectionId: 'other-server' } })
    element('result').textContent = result.isError ? 'denied' : 'called origin'
  } catch {
    // expected: a refused call is the denial this fixture shows
    element('result').textContent = 'denied'
  }
}
element('full').addEventListener('click', () => {
  display('fullscreen').catch(reportFailure)
})
element('back').addEventListener('click', () => {
  display('inline').catch(reportFailure)
})
element('share').addEventListener('click', () => {
  app.updateModelContext({ content: [{ type: 'text', text: `board count is ${count}` }] }).catch(reportFailure)
})
element('call').addEventListener('click', () => {
  callOther().catch(reportFailure)
})
await app.connect()
mode = app.getHostContext()?.displayMode ?? mode
document.body.dataset.connected = 'yes'
render()
