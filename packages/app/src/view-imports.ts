// What an agent app's view may import, shared by the transpiler, the render check and the toolchain build.

/** Each module a view may import, and the frame bundle that brings it (`null`: the core bundle). */
export const VIEW_IMPORTS: Readonly<Record<string, string | null>> = {
  react: null,
  'react/jsx-runtime': null,
  '@goblin/app': null,
  '@goblin/ui': null,
  '@goblin/kit/chart': 'charts',
  recharts: 'charts',
  '@goblin/kit/map': 'maps',
  'react-leaflet': 'maps',
  leaflet: 'maps',
  '@goblin/kit/diagram': 'diagrams',
  'lucide-react': 'icons',
}
