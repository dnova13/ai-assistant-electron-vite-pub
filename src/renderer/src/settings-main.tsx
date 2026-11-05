// 별도 설정창은 대화 컨트롤러·녹음·봇을 새로 시작하지 않는다.
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { SettingsWindow } from './chat/settings/SettingsWindow';
createRoot(document.getElementById('root')!).render(<SettingsWindow />);
