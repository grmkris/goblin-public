// The MCP App views, each built to ONE html file with its script and styles inlined: the host serves it as a
// `ui://` resource into a sandboxed frame that may not load anything. `vite build -c vite.views.config.ts --mode dashboard|receipt`;
// `bun run build:views` builds both. emptyOutDir stays off so the SPA build in `dist/` survives.
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig(({ mode }) => {
  if (mode !== 'dashboard' && mode !== 'receipt')
    throw new Error('build a view with --mode dashboard or --mode receipt')
  return {
    resolve: {
      tsconfigPaths: true,
      // The font files would triple the page; the host's `--font-sans` stack (or the system face) is used instead.
      alias: { '@fontsource-variable/geist': fileURLToPath(new URL('src/views/no-font.css', import.meta.url)) },
    },
    plugins: [tailwindcss(), viteReact(), viteSingleFile()],
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      cssCodeSplit: false,
      assetsInlineLimit: 100_000_000,
      rolldownOptions: { input: `views/${mode}.html` },
    },
  }
})
