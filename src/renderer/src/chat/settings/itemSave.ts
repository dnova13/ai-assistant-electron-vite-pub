// 설정창의 항목별 저장: AI 프로필, TTS 서버, 캐릭터(AI·목소리), 디스코드 연결 하나만 저장한다.
// 설정창은 저장된 설정의 복사본(draft)을 고치므로, 항목 하나만 저장하려면
// "저장된 설정 + 그 항목만 draft 값으로 바꾼 것"을 만들어 저장한다. 다른 탭에서 고치던 값은 저장하지 않는다.
import type { Settings } from '@shared/types';
import { charVoice } from '@shared/char-prefs';

export type ItemKey = { kind: 'profile'; id: string } | { kind: 'tts'; id: string } | { kind: 'char'; id: string } | { kind: 'discord' };

/** 설정창이 AI·TTS·캐릭터 탭에 내려 주는 항목별 저장 도구 */
export interface ItemApi {
  /** 저장된 설정 */
  saved: Settings;
  /** 그 항목만 저장 (from을 주면 편집 중인 설정 대신 그것의 값을 저장). 실패하면 false */
  save: (key: ItemKey, from?: Settings, options?: { silent?: boolean }) => Promise<boolean>;
  /** 항목을 지우고 바로 저장 */
  remove: (key: ItemKey) => Promise<boolean>;
  /** 고치던 값을 버리고 저장된 값으로 되돌림 (저장된 적 없는 새 항목이면 목록에서 뺌) */
  revert: (key: ItemKey) => void;
}

/** 항목 값을 비교용 글로 (저장된 것과 편집 중인 것이 다른가) */
export function itemValue(s: Settings, k: ItemKey): string {
  if (k.kind === 'discord') return JSON.stringify([s.remote.enabled, s.remote.discord]);
  if (k.kind === 'profile') return JSON.stringify(s.profiles[k.id] ?? null);
  if (k.kind === 'tts') return JSON.stringify(s.ttsServers[k.id] ?? null);
  return JSON.stringify([s.characterAi[k.id] ?? '', charVoice(s, k.id)]);
}

export const itemDirty = (draft: Settings, saved: Settings, k: ItemKey): boolean => itemValue(draft, k) !== itemValue(saved, k);

/** base 설정에 from 설정의 그 항목 값만 옮긴다 (from에 없으면 base에서도 지운다) */
export function applyItem(base: Settings, from: Settings, k: ItemKey): Settings {
  if (k.kind === 'discord') return { ...base, remote: { ...base.remote, enabled: from.remote.enabled, discord: from.remote.discord } };
  if (k.kind === 'profile') {
    const profiles = { ...base.profiles };
    if (from.profiles[k.id]) profiles[k.id] = from.profiles[k.id];
    else delete profiles[k.id];
    const characterAi = profiles[k.id] ? base.characterAi : Object.fromEntries(Object.entries(base.characterAi).filter(([, v]) => v !== k.id));
    return { ...base, profiles, characterAi, activeProfile: profiles[base.activeProfile] ? base.activeProfile : '' };
  }
  if (k.kind === 'tts') {
    const ttsServers = { ...base.ttsServers };
    if (from.ttsServers[k.id]) ttsServers[k.id] = from.ttsServers[k.id];
    else delete ttsServers[k.id];
    const characterVoice = ttsServers[k.id]
      ? base.characterVoice
      : Object.fromEntries(Object.entries(base.characterVoice).map(([cid, v]) => [cid, v.server === k.id ? { ...v, engine: 'builtin' as const, server: '' } : v]));
    return { ...base, ttsServers, characterVoice };
  }
  // 캐릭터: 고른 AI와 목소리. 고른 AI 프로필·TTS 서버가 아직 저장 전이면 같이 저장한다 (안 그러면 선택이 사라진다)
  const out: Settings = { ...base, profiles: { ...base.profiles }, ttsServers: { ...base.ttsServers }, characterAi: { ...base.characterAi }, characterVoice: { ...base.characterVoice } };
  const pid = from.characterAi[k.id] || '';
  if (pid && from.profiles[pid]) {
    if (!out.profiles[pid]) out.profiles[pid] = from.profiles[pid];
    out.characterAi[k.id] = pid;
  } else delete out.characterAi[k.id];
  const v = charVoice(from, k.id);
  if (v.server && from.ttsServers[v.server] && !out.ttsServers[v.server]) out.ttsServers[v.server] = from.ttsServers[v.server];
  out.characterVoice[k.id] = v;
  return out;
}

/** 항목을 지운 설정 */
export function removeItem(s: Settings, k: ItemKey): Settings {
  const blank: Settings = { ...s, profiles: { ...s.profiles }, ttsServers: { ...s.ttsServers } };
  if (k.kind === 'profile') delete blank.profiles[k.id];
  if (k.kind === 'tts') delete blank.ttsServers[k.id];
  return applyItem(s, blank, k);
}
