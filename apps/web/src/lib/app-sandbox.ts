import { isString, record } from './boundary.ts'

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
export function sandboxHtml(html: string, metadata: unknown): string {
  const policy = appCsp(metadata).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`
}
export function isSandboxMessage(event: Pick<MessageEvent, 'origin' | 'source'>, source: unknown): boolean {
  return event.source === source && event.origin === 'null'
}
/** Opaque proxy and inner frame cannot access the host's cookies, DOM or storage. Only protocol messages leave the proxy. */
export function sandboxProxy(hostOrigin: string): string {
  const origin = JSON.stringify(new URL(hostOrigin).origin).replaceAll('<', '\\u003c')
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https: wss:; frame-src about: https:"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;background:transparent}</style></head><body><script>
const hostOrigin=${origin};let frame;
window.addEventListener('message',event=>{
 if(event.source===window.parent && event.origin===hostOrigin){
  if(event.data?.method==='ui/notifications/sandbox-resource-ready'){
   if(frame)return;
   if(typeof event.data.params?.html!=='string')return;
   frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.srcdoc=event.data.params.html;document.body.append(frame);
  }else if(frame?.contentWindow)frame.contentWindow.postMessage(event.data,'*');
 }else if(frame && event.source===frame.contentWindow && event.origin==='null')window.parent.postMessage(event.data,hostOrigin);
});
window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}},hostOrigin);
</script></body></html>`
}
