/* MAX-241 原型服务配置。
   原型只读复用 frontend/src 的共享组件与样式，因此以仓库根为 Vite root，
   让裸模块（lit）从 frontend/node_modules 解析。不修改任何产品代码。 */
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

export default {
  root: repoRoot,
  server: {
    host: '127.0.0.1',
    port: 8971,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
        target: 'es2022',
      },
    },
  },
};
