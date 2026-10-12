// The MCP App views, each built to ONE html file with its script and styles inlined: the host serves it as a
// `ui://` resource into a sandboxed frame that may not load anything. `vite build -c vite.views.config.ts --mode dashboard|receipt`;
// `bun run build:views` builds both. emptyOutDir stays off so the SPA build in `dist/` survives.
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const VIEWS = ['dashboard', 'receipt'] as const

export default defineConfig(({ mode }) => {
  // The builds always name a view; a tool that loads the config without one (knip) gets the dashboard's.
  const view = VIEWS.find((name) => name === mode) ?? 'dashboard'
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
      rolldownOptions: { input: `views/${view}.html` },
    },
  }
})
