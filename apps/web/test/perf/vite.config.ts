import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { reactPlugins } from '../../vite.react.ts'

/**
 * The transcript fixture, built for production with the app's own React plugins. `react-dom/profiling` is the
 * production build that still reports to `<Profiler>`, so render counts and durations are measured.
 */
export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    tsconfigPaths: true,
    alias: [{ find: /^react-dom\/client$/u, replacement: 'react-dom/profiling' }],
  },
  plugins: [tailwindcss(), ...reactPlugins()],
  build: { emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 0 },
})
