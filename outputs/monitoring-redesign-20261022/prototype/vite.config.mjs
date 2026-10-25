import {defineConfig} from '../../../frontend/node_modules/vite/dist/node/index.js';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const repo=fileURLToPath(new URL('../../../',import.meta.url));
export default defineConfig({root,base:'./',resolve:{alias:{lit:fileURLToPath(new URL('../../../frontend/node_modules/lit',import.meta.url))}},server:{host:'127.0.0.1',port:18173,strictPort:true,fs:{allow:[repo]}},build:{outDir:'dist',emptyOutDir:true},esbuild:{tsconfigRaw:{compilerOptions:{experimentalDecorators:true,useDefineForClassFields:false}}}});
