import {defineConfig} from 'vite'
import {VitePWA} from 'vite-plugin-pwa'

// An installable wallet, carefully NOT an aggressively-cached one:
// registerType 'prompt' means a new build asks before swapping in (never
// mid-melt), and there is no runtime caching at all - every protocol call
// is a live call or a visible failure, never a stale answer about money.

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'notecase',
        short_name: 'notecase',
        description: 'A case for Lightning bearer notes - money as a secret you hold.',
        theme_color: '#0f1013',
        background_color: '#0f1013',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png'},
          {src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png'},
          {src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'}
        ]
      },
      workbox: {
        navigateFallback: 'index.html',
        runtimeCaching: []
      }
    })
  ]
})
