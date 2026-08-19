import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'

// vite-plugin-pwa's virtual module only exists inside a vite build; the
// test runner aliases it to a no-op so web/src/main.ts imports cleanly.
export default defineConfig({
  resolve: {
    alias: {
      'virtual:pwa-register': fileURLToPath(new URL('./test/pwa-register-stub.ts', import.meta.url))
    }
  }
})
