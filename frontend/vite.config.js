/**
 * 数据库运维前端 - Vite 配置
 */
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [],
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
      'openclaw/plugin-sdk/reply-payload': fileURLToPath(new URL('./src/app/src/plugin-sdk/reply-payload.ts', import.meta.url))
    }
  },
  server: {
    port: 5173,
    strictPort: true, // 端口被占用时报错，不自动尝试其他端口
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/__slide': {
        target: 'http://localhost:28888',
        changeOrigin: true
      }
    }
  }
})
