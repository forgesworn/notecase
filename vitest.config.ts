import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'

// vite-plugin-pwa's virtual module only exists inside a vite build; the
// test runner aliases it to a no-op so web/src/main.ts imports cleanly.
// The PIN is deliberately expensive to try - the KDF is the whole defence
// on a stolen wallet file - so every test that opens one pays for it, and
// several here start an HTTP mint and drive real curve work on top. 5s is
// vitest's default and a unit test's budget: on a loaded machine the slower
// cases here crossed it while passing perfectly well, which made the
// pre-push gate a coin flip. A gate that fails at random teaches people to
// bypass it. 30s is long enough that load never explains a failure and
// short enough that a wedged test still fails the run rather than hanging.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000
  },
  resolve: {
    alias: {
      'virtual:pwa-register': fileURLToPath(new URL('./test/pwa-register-stub.ts', import.meta.url))
    }
  }
})
