import { App } from '@modelcontextprotocol/ext-apps'

const app = new App({ name: 'MyPlan question fixture', version: '1' }, {}, { autoResize: false })
const root = document.createElement('main')
root.innerHTML =
  '<label>Answer <input aria-label="Answer"></label><button type="button">Save answer</button><p role="status">Connecting</p>'
document.body.appendChild(root)
const input = root.querySelector('input')
const button = root.querySelector('button')
const status = root.querySelector('p')

async function stage(result: unknown): Promise<void> {
  if (typeof result !== 'object' || result === null || !('structuredContent' in result)) throw new Error('bad_result')
  const content = result.structuredContent
  if (typeof content !== 'object' || content === null || !('continuation' in content)) return
  const accepted = await app.sendMessage({
    role: 'user',
    content: [{ type: 'text', text: JSON.stringify(content.continuation) }],
  })
  if (status) status.textContent = accepted.isError ? 'Host refused' : 'Saved; use Continue in Goblin'
}

button?.addEventListener('click', () => {
  void app.callServerTool({ name: 'question_answer', arguments: { answer: input?.value ?? '' } }).then(stage)
})
void app
  .connect()
  .then(async () => {
    if (status) status.textContent = 'Ready'
    await stage(await app.callServerTool({ name: 'question_read', arguments: {} }))
  })
  .catch(() => {
    if (status) status.textContent = 'Disconnected'
  })
