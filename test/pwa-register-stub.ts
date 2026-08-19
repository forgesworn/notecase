// Stands in for vite-plugin-pwa's virtual module under vitest, where no
// bundler plugin exists to provide it. See vitest.config.ts.
export const registerSW = (_options?: unknown): ((reload?: boolean) => Promise<void>) => async () => {}
