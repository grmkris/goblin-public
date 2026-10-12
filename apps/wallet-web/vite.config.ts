import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { type Plugin, defineConfig } from 'vite'
import { headersFile, inlineScripts } from './src/security-headers.ts'

/** Emits `_headers` beside the built page, its CSP naming the inline scripts the page ends up with by their hashes. */
const securityHeaders = (): Plugin => ({
  name: 'goblin-wallet-security-headers',
  apply: 'build',
  generateBundle: {
    order: 'post',
    handler(_, bundle) {
      const page = bundle['index.html']
      if (page?.type !== 'asset') throw new Error('the build emitted no index.html for the CSP to hash')
      const html = typeof page.source === 'string' ? page.source : new TextDecoder().decode(page.source)
      const hashes = inlineScripts(html).map((body) => `sha256-${createHash('sha256').update(body).digest('base64')}`)
      this.emitFile({ type: 'asset', fileName: '_headers', source: headersFile(hashes) })
    },
  },
})

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), viteReact(), securityHeaders()],
})
