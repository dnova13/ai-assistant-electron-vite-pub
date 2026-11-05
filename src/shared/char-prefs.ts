// 캐릭터마다 고르는 AI 프로필과 목소리, 설정 > TTS의 TTS 서버 목록.
// - AI: settings.characterAi[캐릭터] = 프로필 id. 없으면 "선택 안 함" (대화 안 됨). 프로필을 지우면 저절로 선택 안 함.
// - 목소리: settings.characterVoice[캐릭터]. 없으면 컴퓨터 음성 기본값. TTS 서버를 지우면 그 캐릭터는 컴퓨터 음성.
// - 예전 설정(전체에 하나뿐인 사용 중 프로필·TTS)은 처음 한 번 migrateCharPrefs로 캐릭터마다 옮긴다.
// 기존 코드(음성 인식·TTS·연결 확인)는 settings.activeProfile과 settings.voice.ttsOut을 읽으므로,
// withCharacter()로 "이 캐릭터 기준"으로 바꿔 끼운 설정을 넘긴다.
import type { CharacterVoice, Profile, Settings, TtsOutSettings, TtsServer } from './types';
import { matchWake, normWake } from './wake';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/** 새 AI 프로필 (설정 > AI의 ＋ 추가) */
export function blankProfile(name = '새 AI'): Profile {
  return { name, type: 'auto', baseUrl: 'http://localhost:11434', apiKey: '', model: '', lowSpecModel: '', systemPrompt: '', temperature: 0.7, timeoutSec: 120 };
}

/** 새 TTS 서버 (설정 > TTS의 ＋ 추가). 주소를 비우면 캐릭터 AI 서버의 TTS(규약 v1) */
export function blankTtsServer(name = '새 TTS'): TtsServer {
  return { name, baseUrl: '', apiKey: '', model: '' };
}

export function normalizeTtsServer(raw: unknown): TtsServer {
  const r = isObj(raw) ? raw : {};
  return { name: str(r.name) || 'TTS', baseUrl: str(r.baseUrl).replace(/\/+$/, ''), apiKey: str(r.apiKey), model: str(r.model) };
}

/** 캐릭터 목소리 기본값: 컴퓨터 음성(자동 한국어), 1배속, 음량 100% */
export function defaultCharVoice(): CharacterVoice {
  return { engine: 'builtin', server: '', voice: '', builtinVoice: '', rate: 1, volume: 100, fallbackBuiltin: true, wakeName: '' };
}

export function normalizeCharVoice(raw: unknown, servers: Record<string, TtsServer>): CharacterVoice {
  const d = defaultCharVoice();
  const r = isObj(raw) ? raw : {};
  const server = str(r.server);
  const hasServer = !!server && !!servers[server];
  return {
    engine: r.engine === 'server' && hasServer ? 'server' : 'builtin', // 서버를 지웠으면 컴퓨터 음성
    server: hasServer ? server : '',
    voice: str(r.voice),
    builtinVoice: typeof r.builtinVoice === 'string' ? r.builtinVoice : '',
    rate: Math.round(clamp(r.rate, d.rate, 0.5, 2) * 10) / 10,
    volume: Math.round(clamp(r.volume, d.volume, 0, 100)),
    fallbackBuiltin: typeof r.fallbackBuiltin === 'boolean' ? r.fallbackBuiltin : d.fallbackBuiltin,
    wakeName: str(r.wakeName).slice(0, 20)
  };
}

/** settings의 캐릭터별 항목을 정리한다 (normalize에서 부름). 없는 프로필을 고른 캐릭터는 선택 안 함 */
export function normalizeCharPrefs(r: Record<string, unknown>, profiles: Record<string, Profile>): Pick<Settings, 'ttsServers' | 'characterAi' | 'characterVoice'> {
  const ttsServers: Record<string, TtsServer> = {};
  if (isObj(r.ttsServers)) for (const [id, v] of Object.entries(r.ttsServers)) ttsServers[id] = normalizeTtsServer(v);
  const characterAi: Record<string, string> = {};
  if (isObj(r.characterAi)) for (const [cid, pid] of Object.entries(r.characterAi)) if (typeof pid === 'string' && profiles[pid]) characterAi[cid] = pid;
  const characterVoice: Record<string, CharacterVoice> = {};
  if (isObj(r.characterVoice)) for (const [cid, v] of Object.entries(r.characterVoice)) characterVoice[cid] = normalizeCharVoice(v, ttsServers);
  return { ttsServers, characterAi, characterVoice };
}

/** 캐릭터가 고른 AI 프로필 id ('' = 선택 안 함) */
export function charProfileId(s: Pick<Settings, 'characterAi' | 'profiles'>, charId: string): string {
  const pid = s.characterAi[charId];
  return pid && s.profiles[pid] ? pid : '';
}

/** 캐릭터가 고른 AI 프로필 (없으면 null) */
export function charProfile(s: Pick<Settings, 'characterAi' | 'profiles'>, charId: string): Profile | null {
  const pid = charProfileId(s, charId);
  return pid ? s.profiles[pid] : null;
}

/** 캐릭터 목소리 설정 (저장된 것이 없으면 기본값) */
export function charVoice(s: Pick<Settings, 'characterVoice' | 'ttsServers'>, charId: string): CharacterVoice {
  return s.characterVoice[charId] ? normalizeCharVoice(s.characterVoice[charId], s.ttsServers) : defaultCharVoice();
}

/** 캐릭터 목소리를 기존 TTS 코드가 읽는 모양(TtsOutSettings)으로 */
export function charTtsOut(s: Pick<Settings, 'characterVoice' | 'ttsServers'>, charId: string): TtsOutSettings {
  const v = charVoice(s, charId);
  const srv = v.engine === 'server' ? s.ttsServers[v.server] : undefined;
  return {
    source: srv ? 'server' : 'builtin',
    fallbackBuiltin: v.fallbackBuiltin,
    volume: v.volume,
    builtin: { voice: v.builtinVoice, rate: v.rate },
    server: srv ? { baseUrl: srv.baseUrl, apiKey: srv.apiKey, voice: v.voice, model: srv.model } : { baseUrl: '', apiKey: '', voice: '', model: '' }
  };
}

/** 이 캐릭터 기준 설정: activeProfile = 캐릭터의 AI ('' 가능), voice.ttsOut = 캐릭터 목소리 */
export function withCharacter(s: Settings, charId: string): Settings {
  return { ...s, activeProfile: charProfileId(s, charId), voice: { ...s.voice, ttsOut: charTtsOut(s, charId) } };
}

/** 이 프로필을 고른 캐릭터 id 목록 */
export function charactersUsingProfile(s: Pick<Settings, 'characterAi'>, profileId: string): string[] {
  return Object.entries(s.characterAi)
    .filter(([, pid]) => pid === profileId)
    .map(([cid]) => cid);
}

/** 이 TTS 서버를 쓰는 캐릭터 id 목록 */
export function charactersUsingTts(s: Pick<Settings, 'characterVoice'>, serverId: string): string[] {
  return Object.entries(s.characterVoice)
    .filter(([, v]) => v && v.engine === 'server' && v.server === serverId)
    .map(([cid]) => cid);
}

/** 새 항목 id (겹치지 않게) */
export function newId(prefix: string, taken: Record<string, unknown>): string {
  let id = `${prefix}${Date.now().toString(36)}`;
  for (let i = 2; taken[id]; i++) id = `${prefix}${Date.now().toString(36)}${i}`;
  return id;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * 예전 설정을 캐릭터마다 옮긴다 (한 번만). 전체에 하나였던 사용 중 프로필을 캐릭터마다 고른 것으로,
 * 전체 TTS 설정을 TTS 서버 하나 + 캐릭터 목소리로. 이미 캐릭터에 정해 둔 값은 건드리지 않는다.
 */
export function migrateCharPrefs(s: Settings, charIds: string[]): Settings {
  if (s.charPrefsMigrated) return s;
  const out: Settings = { ...s, ttsServers: { ...s.ttsServers }, characterAi: { ...s.characterAi }, characterVoice: { ...s.characterVoice }, charPrefsMigrated: true };
  const old = s.voice.ttsOut;
  let serverId = '';
  if (old.source === 'server' || old.server.baseUrl) {
    serverId = newId('tts', out.ttsServers);
    out.ttsServers[serverId] = { name: old.server.baseUrl ? hostOf(old.server.baseUrl) : 'AI 서버 목소리', baseUrl: old.server.baseUrl, apiKey: old.server.apiKey, model: old.server.model };
  }
  const active = s.profiles[s.activeProfile] ? s.activeProfile : '';
  for (const id of charIds) {
    if (active && !out.characterAi[id]) out.characterAi[id] = active;
    if (!out.characterVoice[id])
      out.characterVoice[id] = {
        engine: old.source === 'server' && serverId ? 'server' : 'builtin',
        server: serverId,
        voice: old.server.voice,
        builtinVoice: old.builtin.voice,
        rate: old.builtin.rate,
        volume: old.volume,
        fallbackBuiltin: old.fallbackBuiltin,
        wakeName: ''
      };
  }
  return out;
}

/* ---------------- 호출어 (캐릭터마다, 설정 > 캐릭터 > 목소리) ---------------- */

/** 캐릭터의 호출어: 정해 둔 것 → 비었으면 캐릭터 이름 */
export function charWakeName(s: Pick<Settings, 'characterVoice' | 'ttsServers'>, charId: string, charName: string): string {
  return charVoice(s, charId).wakeName || String(charName || '').trim();
}

/**
 * 받아 적은 글이 어느 캐릭터의 호출어로 시작하는지 (없으면 '').
 * chars는 캐릭터 순서대로: 호출어가 같은 캐릭터가 있으면 앞에 있는 캐릭터.
 */
export function findWakeCharacter(text: string, s: Pick<Settings, 'characterVoice' | 'ttsServers'>, chars: { id: string; name: string }[]): string {
  for (const c of chars) if (matchWake(text, charWakeName(s, c.id, c.name))) return c.id;
  return '';
}

/** 이 캐릭터와 호출어가 같은 다른 캐릭터 이름들 (wake = 이 캐릭터의 호출어) */
export function wakeConflicts(wake: string, s: Pick<Settings, 'characterVoice' | 'ttsServers'>, others: { id: string; name: string }[]): string[] {
  const n = normWake(wake);
  if (!n) return [];
  return others.filter((c) => normWake(charWakeName(s, c.id, c.name)) === n).map((c) => c.name);
}

/** 예전 설정의 전체 호출어(voice.wake.name)를 지금 캐릭터의 호출어로 옮긴다 (그 뒤 전체 호출어는 비운다) */
export function migrateWakeName(s: Settings): Settings {
  const name = s.voice.wake.name;
  if (!name) return s;
  const cur = charVoice(s, s.character);
  return {
    ...s,
    characterVoice: { ...s.characterVoice, [s.character]: { ...cur, wakeName: cur.wakeName || name } },
    voice: { ...s.voice, wake: { ...s.voice.wake, name: '' } }
  };
}
