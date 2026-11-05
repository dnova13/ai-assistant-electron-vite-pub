// 설정창은 대화 상태 일부와 허용된 작업만 주고받는다. 대화 기록은 보내지 않는다.
import type { AppInfo, Character, Health, LocalSttStatus, RootEntry, Settings } from './types';
export interface SettingsView {
  info: AppInfo | null; settings: Settings | null; roots: RootEntry[]; characters: Character[];
  health: Health | null; localStt: LocalSttStatus | null; noiseDb: number | null; wakeNoiseDb: number | null;
}
export const SETTINGS_METHODS = ['saveSettings', 'reloadCharacters', 'afterCharacterChange', 'setCharacterHidden', 'setCharacterLocked', 'setCharacterOrder', 'clearHistory', 'refreshLocalStt', 'addMsg'] as const;
export type SettingsMethod = typeof SETTINGS_METHODS[number];
export interface SettingsCall { id: string; method: SettingsMethod; args: unknown[] }
