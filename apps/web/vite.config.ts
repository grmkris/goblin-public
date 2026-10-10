import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { reactPlugins } from './vite.react.ts'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  build: { rolldownOptions: { external: [/^cloudflare:/] } },
  plugins: [tailwindcss(), tanstackStart(), ...reactPlugins()],
})
