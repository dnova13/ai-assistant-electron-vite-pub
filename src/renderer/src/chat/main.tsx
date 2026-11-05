// 대화 창 화면의 시작점
import { createRoot } from 'react-dom/client';
import '../styles/app.css';
import { App } from './App';

// StrictMode는 쓰지 않는다: 개발 중 효과를 두 번 실행해 IPC 구독·녹음 장치가 겹치기 때문
createRoot(document.getElementById('root')!).render(<App />);
