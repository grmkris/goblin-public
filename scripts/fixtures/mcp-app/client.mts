import { App } from '@modelcontextprotocol/ext-apps'

/** SDK-connected browser fixture. Its count is lost on frame reload, making placement continuity observable. */
const app = new App({ name: 'fixture-board', version: '1' }, {}, { autoResize: false })
const element = (id: string) => {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`Missing fixture element ${id}`)
  return found
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
element('full').addEventListener('click', () => {
  void (async () => {
    mode = (await app.requestDisplayMode({ mode: 'fullscreen' })).mode
    render()
  })()
})
element('back').addEventListener('click', () => {
  void (async () => {
    mode = (await app.requestDisplayMode({ mode: 'inline' })).mode
    render()
  })()
})
element('share').addEventListener('click', () => {
  void app.updateModelContext({ content: [{ type: 'text', text: `board count is ${count}` }] })
})
element('call').addEventListener('click', () => {
  void (async () => {
    try {
      const result = await app.callServerTool({ name: 'board', arguments: { serverId: 'other-server' } })
      element('result').textContent = result.isError ? 'denied' : 'called origin'
    } catch {
      element('result').textContent = 'denied'
    }
  })()
})
await app.connect()
mode = app.getHostContext()?.displayMode ?? mode
document.body.dataset.connected = 'yes'
render()
