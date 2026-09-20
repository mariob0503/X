import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  server: { host: true, port: 5173, allowedHosts: true },
  preview: { host: true, port: 4173, allowedHosts: true },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'bfit24-favicon.png',
        'bfit24-logo.png',
        'bfit24-logo.svg',
        'bfit24-logo-dark.svg',
        'apple-touch-icon.png',
      ],
      manifest: {
        name: 'Plate Race — BFit24',
        short_name: 'Plate Race',
        description: 'Push the dumbbell. Rack plates. Dump your rival. Best of 3.',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          {
            src: 'bfit24-favicon.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'apple-touch-icon.png',
            sizes: '180x180',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'bfit24-logo.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webp,woff2}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
});
