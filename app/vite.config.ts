import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from 'path';
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const host = process.env.TAURI_DEV_HOST || '0.0.0.0';
const EXPRESS_PORT = 1111;
const isDev = process.env.NODE_ENV === 'development';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(), 
    tailwindcss(),
    // PWA: Only enabled in production, disabled in development to avoid caching issues
    ...(!isDev && !process.env.DISABLE_PWA ? [
      VitePWA({
        // Disable in development mode
        devOptions: {
          enabled: false
        },
        // Auto update service worker when new version is available
        registerType: 'autoUpdate',
        includeAssets: ['icons/Square*.png'],
        manifest: {
          name: 'Blinko',
          short_name: 'Blinko',
          icons: [
            {
              src: '/icons/Square30x30Logo.png',
              sizes: '30x30',
              type: 'image/png'
            },
            {
              src: '/icons/Square44x44Logo.png',
              sizes: '44x44',
              type: 'image/png'
            },
            {
              src: '/icons/Square71x71Logo.png',
              sizes: '71x71',
              type: 'image/png'
            },
            {
              src: '/icons/Square89x89Logo.png',
              sizes: '89x89',
              type: 'image/png'
            },
            {
              src: '/icons/Square107x107Logo.png',
              sizes: '107x107',
              type: 'image/png'
            },
            {
              src: '/icons/Square142x142Logo.png',
              sizes: '142x142',
              type: 'image/png'
            },
            {
              src: '/icons/Square150x150Logo.png',
              sizes: '150x150',
              type: 'image/png'
            },
            {
              src: '/icons/Square284x284Logo.png',
              sizes: '284x284',
              type: 'image/png'
            },
            {
              src: '/icons/Square310x310Logo.png',
              sizes: '310x310',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ],
          theme_color: '#FFFFFF',
          background_color: '#FFFFFF',
          start_url: '/',
          display: 'standalone',
          orientation: 'portrait'
        },
        workbox: {
          // Maximum file size to cache (10MB)
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          // Don't cache API requests
          navigateFallbackDenylist: [/^\/api\/.*/],
          // Clean old caches automatically
          cleanupOutdatedCaches: true,
          // Runtime caching strategy for better update control
          runtimeCaching: [
            {
              // Cache API responses with network-first strategy
              urlPattern: /^https:\/\/api\..*/i,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'api-cache',
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 5 * 60, // 5 minutes
                },
                networkTimeoutSeconds: 10,
              },
            },
            {
              // Cache images with cache-first strategy
              urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'image-cache',
                expiration: {
                  maxEntries: 100,
                  maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                },
              },
            },
          ],
        },
      })
    ] : [])
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/react') || 
              id.includes('node_modules/react-dom') || 
              id.includes('node_modules/react-router-dom')) {
            return 'react-vendor';
          }
          
          if (id.includes('node_modules/@react-') || 
              id.includes('node_modules/react-') || 
              id.includes('node_modules/@ui-') || 
              id.includes('node_modules/@headlessui') || 
              id.includes('node_modules/headlessui')) {
            return 'ui-components';
          }
          
          if (id.includes('node_modules/lodash') || 
              id.includes('node_modules/axios') || 
              id.includes('node_modules/date-fns')) {
            return 'utils';
          }
        }
      }
    }
  },
  clearScreen: false,
  server: {
    port: EXPRESS_PORT,
    strictPort: false,
    host: host || false,
    allowedHosts: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/node_modules/**", "**/.git/**"],
    },
  },
  optimizeDeps: {
    force: false,
    include: ['react', 'react-dom', 'react-router-dom'],
    exclude: []
  },
  css: {
    devSourcemap: false
  },
  cacheDir: 'node_modules/.vite',
  experimental: {
    renderBuiltUrl: (filename) => ({ relative: true }),
    hmrPartialAccept: true
  }
});
