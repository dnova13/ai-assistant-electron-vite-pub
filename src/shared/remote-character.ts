import type { Character, Settings } from './types';
import { sortCharacters, visibleCharacters } from './character-order';
import { charProfileId } from './char-prefs';
export const NO_REMOTE_CHARACTER = '연결된 AI를 사용하는 표시 캐릭터가 없습니다. 앱 설정 > 캐릭터 > 프로필 > AI에서 해당 AI 프로필을 선택해 주세요. 숨겨진 캐릭터라면 숨김을 해제해 주세요.';
/** 같은 등록 프로필을 쓰는 현재 표시 캐릭터를 우선하고, 없으면 표시 순서로 배정한다. */
export function remoteCharacter(s: Pick<Settings, 'profiles' | 'characterAi' | 'characterOrder' | 'hiddenCharacters' | 'character'>, characters: Character[], profile: string): Character | null {
  if (!profile || !s.profiles[profile]) return null;
  const matching = visibleCharacters(sortCharacters(characters, s.characterOrder), s.hiddenCharacters).filter(c => charProfileId(s, c.id) === profile);
  return matching.find(c => c.id === s.character) || matching[0] || null;
}
