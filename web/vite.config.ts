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
        // "Share to notecase" from any app. A POST target, because a
        // shared payload can be a live bearer note and the secret in it is
        // the money: a GET puts that secret in the request line, which is
        // what a web server writes to its access log. share-handler.js
        // takes the POST in the service worker, stashes the fields and
        // redirects to a clean root, so the secret never appears in a URL,
        // in history, or in a referrer. Nothing is ever accepted
        // automatically: it lands in the receive screen.
        share_target: {
          action: '/share',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {title: 'title', text: 'text', url: 'url'}
        }
      },
      workbox: {
        navigateFallback: 'index.html',
        runtimeCaching: [],
        // Imported at the top of the generated worker, so its fetch
        // listener registers before Workbox's navigation route and gets
        // first refusal on the share POST.
        importScripts: ['/share-handler.js']
      }
    })
  ]
})
