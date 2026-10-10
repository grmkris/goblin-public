import viteReact from '@vitejs/plugin-react'

/**
 * The React plugins the web app builds with. The performance fixture (`test/perf/`) builds with the same ones, so what
 * it measures is what ships.
 */
export const reactPlugins = () => [viteReact()]
