# vendor

Live2D Cubism Core를 여기에 넣는다: `vendor/live2dcubismcore.min.js`

- Live2D 공식 사이트의 **Cubism SDK for Web**을 받아서 `Core/live2dcubismcore.min.js`를 복사한다.
- 라이선스(Live2D Proprietary Software License) 때문에 npm 패키지로 받을 수 없어 저장소에 넣지 않는다 (`.gitignore`에 있음). 사용 조건은 공식 사이트에서 확인한다.
- 설치본(빌드한 앱)에서는 사용자 데이터 폴더의 `live2d/live2dcubismcore.min.js`도 찾는다 (맥: `~/Library/Application Support/ai-assistant-electron-vite/live2d/`, 윈도우: `%APPDATA%\ai-assistant-electron-vite\live2d\`). 설정 > 캐릭터 탭에 정확한 경로가 나온다.

나머지 Live2D 라이브러리(PixiJS, pixi-live2d-display)는 `npm install`로 받는다.
