import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_PROXY_TARGET || 'http://127.0.0.1:8001'
  const apiProxy = {
    '/api': {
      target,
      changeOrigin: true,
      rewrite: (path) => {
        const stripped = path.replace(/^\/api/, '')
        return stripped === '' ? '/' : stripped
      },
    },
  }

  return {
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      include: ['mermaid'],
    },
    server: {
      proxy: apiProxy,
    },
    preview: {
      proxy: apiProxy,
    },
  }
})
