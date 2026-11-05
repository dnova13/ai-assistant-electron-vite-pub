/// <reference types="vite/client" />
import type { AppApi } from '@shared/types';

declare global {
  interface Window {
    /** preload가 열어 준 기능 (src/preload/index.ts) */
    app: AppApi;
    /** Live2D용 PixiJS (실행 중에 app://local/vendor/ 에서 불러온다) */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PIXI?: any;
  }
}

export {};
