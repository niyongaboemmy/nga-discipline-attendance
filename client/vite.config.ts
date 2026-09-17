import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Where the dev server forwards /api. Defaults to the server running on this
// machine; docker-compose overrides it with the backend container's hostname.
const apiProxyTarget = process.env.TENDO_API_PROXY_TARGET ?? 'http://localhost:5171'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
