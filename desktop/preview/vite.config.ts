import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Serves the real renderer against a stubbed `window.hollow`.
 *
 * Only used to capture the screenshots in the README: there is no way to run
 * the actual app on a machine without Steam, and a hand-drawn mockup would
 * drift from the interface the moment either changed. This renders the genuine
 * components and the genuine stylesheet — only the data behind them is made up.
 */
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: { '@app': resolve(__dirname, '../src/renderer/src') },
  },
  server: {
    port: 5199,
    fs: { allow: [resolve(__dirname, '..')] },
  },
})
