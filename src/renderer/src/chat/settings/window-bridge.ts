import type { ChatController, ChatState } from '../controller';
import { SETTINGS_METHODS, type SettingsView } from '@shared/settings-window';
export type SettingsActions = Pick<ChatController, 'saveSettings' | 'reloadCharacters' | 'afterCharacterChange' | 'setCharacterHidden' | 'setCharacterLocked' | 'setCharacterOrder' | 'clearHistory' | 'refreshLocalStt' | 'addMsg' | 'learnedNoiseDb' | 'learnedWakeNoiseDb' | 'characterName' | 'characterId'>;
export type SettingsState = Pick<ChatState, 'info' | 'settings' | 'roots' | 'characters' | 'health' | 'localStt'>;
export function connectSettingsHost(controller: ChatController): () => void {
  const api = window.app.settingsWindow;
  const publish = () => {
    const { info, settings, roots, characters, health, localStt } = controller.getState();
    api.publish({ info, settings, roots, characters, health, localStt, noiseDb: controller.learnedNoiseDb(), wakeNoiseDb: controller.learnedWakeNoiseDb() });
  };
  let previous: unknown[] = [];
  const offState = controller.subscribe(() => {
    const s = controller.getState(); const next = [s.info,s.settings,s.roots,s.characters,s.health,s.localStt];
    if (next.some((value,i) => value !== previous[i])) { previous = next; publish(); }
  });
  const offCmd = window.app.win.onCommand(({cmd}) => { if (cmd === 'settingsSnapshot') publish(); });
  const offCall = api.onCall(async ({id,method,args}) => {
    if (!SETTINGS_METHODS.includes(method)) return;
    try {
      const fn = controller[method] as (...args: unknown[]) => unknown;
      const value = await fn.apply(controller,args);
      publish(); api.reply(id, value);
    } catch (e) { api.reply(id, null, e instanceof Error ? e.message : '설정 작업을 처리하지 못했습니다.'); }
  });
  return () => { offState(); offCmd(); offCall(); };
}
export const EMPTY_SETTINGS_VIEW: SettingsView = { info:null, settings:null, roots:[], characters:[], health:null, localStt:null, noiseDb:null, wakeNoiseDb:null };
