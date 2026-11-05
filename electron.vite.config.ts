import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// 메인·preload는 Node용으로, 화면(renderer)은 React로 빌드한다.
// 결과물: out/main/index.js, out/preload/index.js, out/renderer/{index,mascot}.html
export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        // stt-worker: 앱 안 위스퍼를 돌리는 별도 프로세스 (out/main/stt-worker.js)
        input: { index: resolve('src/main/index.ts'), 'stt-worker': resolve('src/main/stt-worker.ts') }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: resolve('src/renderer'),
    // 설치본에서는 app://local/renderer/ 아래에서 열리므로 상대 경로로 만든다
    base: './',
    resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          mascot: resolve('src/renderer/mascot.html'),
          settings: resolve('src/renderer/settings.html')
        }
      }
    }
  }
});
