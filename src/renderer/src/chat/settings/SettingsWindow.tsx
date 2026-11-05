import { useEffect, useState } from 'react';
import type { SettingsView } from '@shared/settings-window';
import { SettingsModal } from './SettingsModal';
import { EMPTY_SETTINGS_VIEW, type SettingsActions } from './window-bridge';
export function SettingsWindow() {
  const [view,setView] = useState<SettingsView>(EMPTY_SETTINGS_VIEW);
  const [error,setError] = useState('');
  useEffect(() => {
    const off = window.app.settingsWindow.onView(setView);
    void window.app.settingsWindow.refresh().catch(() => setError('대화창에 연결하지 못했습니다. 설정창을 다시 열어 주세요.'));
    return off;
  },[]);
  const call = <T,>(method: Parameters<typeof window.app.settingsWindow.call>[0], args: unknown[] = []) => window.app.settingsWindow.call(method,args) as Promise<T>;
  const controller: SettingsActions = {
    saveSettings: (settings,roots) => call('saveSettings',[settings,roots]),
    reloadCharacters: () => call('reloadCharacters'), afterCharacterChange: () => call('afterCharacterChange'),
    setCharacterHidden: (id,on) => call('setCharacterHidden',[id,on]),
    setCharacterLocked: (id,on) => call('setCharacterLocked',[id,on]), setCharacterOrder: (ids) => call('setCharacterOrder',[ids]),
    clearHistory: (id) => call('clearHistory',[id]), refreshLocalStt: () => call('refreshLocalStt'),
    addMsg: (kind,text,opts) => { void call('addMsg',[kind,text,opts]).catch(() => {}); return 0; },
    learnedNoiseDb: () => view.noiseDb, learnedWakeNoiseDb: () => view.wakeNoiseDb,
    characterId: () => view.settings?.character || '',
    characterName: (id) => { const c=view.characters.find(c=>c.id===id);return String(c?.config.name || id || '비서'); }
  };
  return <>{!view.settings && !error && <p className="hint">설정을 불러오는 중입니다…</p>}{error && <p role="alert">{error}</p>}<SettingsModal open controller={controller} state={view} standalone onClose={() => { void window.app.settingsWindow.close(); }} /></>;
}
