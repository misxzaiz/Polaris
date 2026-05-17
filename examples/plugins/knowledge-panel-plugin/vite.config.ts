/**
 * Vite build configuration for the Knowledge panel plugin.
 *
 * ## Output contract
 *
 * - Single ES module `dist/index.js` with a React component as `default`
 *   export. The component receives `{ api: PolarisPluginApi }` as props.
 * - All host-provided runtime libraries are marked `external` so they are
 *   resolved against the host's bundled copies at runtime. The host's
 *   `installer.ts` injects React / ReactDOM / Zustand / i18next via the
 *   `api.*` surface — they MUST be the same instances as the host's.
 *
 * ## How the host loads us
 *
 * In development (`pnpm dev` on the host) the plugin is served from
 * `/examples/plugins/knowledge-panel-plugin/dist/index.js` via Vite's
 * filesystem.
 *
 * In Tauri builds, the plugin directory is installed to
 * `<appConfig>/plugins/polaris.knowledge/` and loaded via
 * `convertFileSrc(...)`.
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

// Anything the host already bundles must be `external` so we don't pull
// a duplicate copy. The list is exhaustive — if a new host singleton is
// added (e.g. another @codemirror lang package), add it here.
const HOST_PROVIDED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'i18next',
  'react-i18next',
  'zustand',
  'lucide-react',
  'mermaid',
  // Tauri APIs flow through the plugin's `api.transport.invoke` /
  // `api.convertFileSrc` — direct imports are not part of the plugin
  // contract.
  /^@tauri-apps\//,
]

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: 'esbuild',
    lib: {
      entry: resolve(here, 'src/index.tsx'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: HOST_PROVIDED,
    },
  },
})
