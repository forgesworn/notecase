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
        ],
        // "Share to notecase" from any app. A GET target, so the payload
        // arrives in the query string and is scrubbed out of the address
        // bar the moment it is read - the same handling the claim fragment
        // gets, because a shared note URL is a live secret too. Nothing is
        // ever accepted automatically: it lands in the receive screen.
        share_target: {
          action: '/share',
          method: 'GET',
          params: {text: 'text', url: 'url'}
        }
      },
      workbox: {
        navigateFallback: 'index.html',
        runtimeCaching: []
      }
    })
  ]
})
