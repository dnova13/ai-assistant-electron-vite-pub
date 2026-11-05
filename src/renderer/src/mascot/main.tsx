// 마스코트 창 화면의 시작점
import { createRoot } from 'react-dom/client';
import '../styles/mascot.css';
import { Mascot } from './Mascot';

createRoot(document.getElementById('root')!).render(<Mascot />);
