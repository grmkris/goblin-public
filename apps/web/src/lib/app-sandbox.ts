import type { AgentAppLaunch, AgentAppLib } from '@goblin/contracts'
import { isString, record } from './values.ts'

function domains(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!isString(item)) return []
    try {
      const url = new URL(item)
      return (url.protocol === 'https:' || url.protocol === 'wss:') &&
        url.origin === item &&
        !url.username &&
        !url.password
        ? [url.origin]
        : []
    } catch {
      // expected: a declared domain that is not a URL is left out of the App's policy
      return []
    }
  })
}
export function appCsp(metadata: unknown): string {
  const csp = record(record(metadata)?.ui)?.csp
  const policy = record(csp)
  const resources = domains(policy?.resourceDomains)
    .filter((domain) => domain.startsWith('https:'))
    .join(' ')
  const connect = domains(policy?.connectDomains).join(' ') || "'none'"
  const frames =
    domains(policy?.frameDomains)
      .filter((domain) => domain.startsWith('https:'))
      .join(' ') || "'none'"
  return `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: blob: ${resources}; font-src data: ${resources}; media-src data: blob: ${resources}; connect-src ${connect}; frame-src ${frames}; base-uri 'none'; form-action 'none'; object-src 'none'`
}
const attribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

export function sandboxHtml(html: string, metadata: unknown): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${attribute(appCsp(metadata))}">${html}`
}

/** The one host an agent app's map may load tiles from. */
const TILES = 'https://tile.openstreetmap.org'

/** What an agent app's frame loads from goblin: its bundles' URLs on `origin`, and goblin's stylesheets. */
export type FrameAssets = {
  readonly origin: string
  readonly scripts: Readonly<Record<'core' | AgentAppLib, string>>
  readonly styles: { readonly ui: string; readonly maps: string }
}

/**
 * An agent app's frame policy (ADR 0021): scripts only inline (its own module) and goblin's bundles, no network at
 * all, and images from the tile host only when it draws maps.
 */
export function agentAppCsp(origin: string, libs: readonly AgentAppLib[]): string {
  const tiles = libs.includes('maps') ? ` ${TILES}` : ''
  return `default-src 'none'; script-src 'unsafe-inline' ${origin}; style-src 'unsafe-inline'; img-src data: blob:${tiles}; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`
}

/** Text inside a `<script>` or `<style>` element that cannot end it early (`<\/` reads as `</` in JS and CSS). */
const inert = (text: string) => text.replaceAll(/<\/(script|style)/giu, '<\\/$1')

/**
 * Runs before any bundle: keeps every error until the core's start reports them, so a bundle that fails as it loads
 * (a script that throws, or one that never arrives) is not lost before the frame can speak to the host. The core takes
 * the list and sets it to `null`, after which its own listeners report.
 */
const EARLY_ERRORS = `window.__goblinEarly=[];(function(){function keep(m){var q=window.__goblinEarly;if(q)q.push(String(m).slice(0,1000))}addEventListener('error',function(e){var t=e.target;if(t&&t.tagName==='SCRIPT')keep('Could not load '+String(t.src).split('/').pop());else keep((e.message||'Error')+(e.filename?' ('+e.filename.split('/').pop()+':'+e.lineno+')':''))},true);addEventListener('unhandledrejection',function(e){keep('Unhandled: '+String(e.reason))})})()`

/**
 * An agent app's view as a document: goblin's styles and the app's own, the frame bundles it needs, and its module
 * (CommonJS from the transpiler) run once the first state arrives. Errors before the core starts are kept for it.
 */
export function agentAppHtml(view: AgentAppLaunch['ui'], assets: FrameAssets): string {
  const scripts = ['core' as const, ...view.libs].map(
    (lib) => `<script src="${attribute(assets.scripts[lib])}"></script>`,
  )
  const styles = [assets.styles.ui, view.libs.includes('maps') ? assets.styles.maps : '', view.css]
  const start = `__goblinStart(function () { var module = { exports: {} }; (function (require, module, exports) {\n${inert(view.module)}\n})(__goblinRequire, module, module.exports); return module.exports.default })`
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${attribute(agentAppCsp(assets.origin, view.libs))}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...styles.filter((css) => css !== '').map((css) => `<style>${inert(css)}</style>`),
    '</head><body><div id="root"></div>',
    `<script>${EARLY_ERRORS}</script>`,
    ...scripts,
    `<script>${start}</script>`,
    '</body></html>',
  ].join('')
}
/**
 * The sandbox of an App's frames. An agent app's view may use forms: without `allow-forms` a browser refuses a form's
 * submission before its `submit` event, so the view's handler would never run; its CSP (`form-action 'none'`) still
 * stops any real submission. An MCP App keeps scripts only.
 */
export const appSandbox = (kind: 'mcp' | 'agent'): string =>
  kind === 'agent' ? 'allow-scripts allow-forms' : 'allow-scripts'

export function isSandboxMessage(event: Pick<MessageEvent, 'origin' | 'source'>, source: unknown): boolean {
  return event.source === source && event.origin === 'null'
}
/** Opaque proxy and inner frame cannot access the host's cookies, DOM or storage. Only protocol messages leave the proxy. */
export function sandboxProxy(hostOrigin: string): string {
  const host = new URL(hostOrigin).origin
  const origin = JSON.stringify(host).replaceAll('<', '\\u003c')
  // The inner frame inherits this policy too: an agent app's bundles come from the host's own origin.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https: ${attribute(host)}; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https: wss:; frame-src about: https:"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;background:transparent}</style></head><body><script>
const hostOrigin=${origin};let frame;
window.addEventListener('message',event=>{
 if(event.source===window.parent && event.origin===hostOrigin){
  if(event.data?.method==='ui/notifications/sandbox-resource-ready'){
   if(frame)return;
   if(typeof event.data.params?.html!=='string')return;
   frame=document.createElement('iframe');frame.setAttribute('sandbox',event.data.params.sandbox==='allow-scripts allow-forms'?'allow-scripts allow-forms':'allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.srcdoc=event.data.params.html;document.body.append(frame);
  }else if(frame?.contentWindow)frame.contentWindow.postMessage(event.data,'*');
 }else if(frame && event.source===frame.contentWindow && event.origin==='null')window.parent.postMessage(event.data,hostOrigin);
});
window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}},hostOrigin);
</script></body></html>`
}
