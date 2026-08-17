/**
 * 数据库运维前端 - Vite 配置
 */
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000'
const agentWsProxyTarget = process.env.VITE_AGENT_WS_PROXY_TARGET || 'http://localhost:28888'

export default defineConfig({
  plugins: [],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/echarts/') || id.includes('/zrender/')) return 'charts'
          if (id.includes('/@codemirror/') || id.includes('/codemirror/')) return 'editor'
          if (id.includes('/marked/') || id.includes('/markdown-it') || id.includes('/@create-markdown/')) return 'markdown'
          if (id.includes('/lit/') || id.includes('/lit-html/')) return 'lit'
          return undefined
        }
      }
    }
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@api': fileURLToPath(new URL('./src/api', import.meta.url)),
      '@utils': fileURLToPath(new URL('./src/utils', import.meta.url)),
      '@components': fileURLToPath(new URL('./src/components', import.meta.url)),
      '@pages': fileURLToPath(new URL('./src/pages', import.meta.url)),
      '@styles': fileURLToPath(new URL('./src/styles', import.meta.url)),
      // Slide app aliases
      '@slide/app/src': fileURLToPath(new URL('./src/app/src', import.meta.url)),
      '@slide/app/ui': fileURLToPath(new URL('./src/app/ui', import.meta.url)),
      '@agent/plugin-sdk/reply-payload': fileURLToPath(new URL('./src/app/src/plugin-sdk/reply-payload.ts', import.meta.url))
    }
  },
  server: {
    port: 5173,
    strictPort: true, // 端口被占用时报错，不自动尝试其他端口
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true
      },
      '/__slide': {
        target: agentWsProxyTarget,
        changeOrigin: true
      },
      '/agent-ws': {
        target: agentWsProxyTarget,
        changeOrigin: true,
        ws: true
      }
    }
  }
})
