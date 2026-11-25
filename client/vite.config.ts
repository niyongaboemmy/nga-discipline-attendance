import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Where the dev server forwards /api. Defaults to the server running on this
// machine; docker-compose overrides it with the backend container's hostname.
const apiProxyTarget = process.env.TENDO_API_PROXY_TARGET ?? 'http://localhost:5171'

/** The staff clock page (/c/<school>) is its own small entry, clock.html. In
 *  production nginx serves it for /c/*; this does the same for `vite dev`. */
function clockPageRewrite(): Plugin {
  return {
    name: 'tendo-clock-page',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/c(\/|$|\?)/.test(req.url)) req.url = '/clock.html'
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/c(\/|$|\?)/.test(req.url)) req.url = '/clock.html'
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), clockPageRewrite()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        clock: resolve(__dirname, 'clock.html'),
      },
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    host: true, // bind 0.0.0.0 so the port is reachable from outside a container
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
