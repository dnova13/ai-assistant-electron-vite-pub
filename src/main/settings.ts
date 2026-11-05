// settings.json 읽기/쓰기. API 토큰은 OS 보안 저장소(맥 키체인, 윈도우 DPAPI)로 암호화해서 저장한다.
import fs from 'node:fs';
import path from 'node:path';
import type { Profile, Settings } from '@shared/types';
import { isProviderType } from '@shared/providers';
import { blankProfile, normalizeCharPrefs } from '@shared/char-prefs';
import { normalizeFileNameMethod } from '@shared/file-names';
import { connectionInfo } from '@shared/profile-summary';
import type { Health } from '@shared/types';
import { MASCOT_HIDE, normalizeHideSec } from '@shared/mascot';
import { defaultStt, normalizeStt } from '@shared/stt';
import { defaultWake, normalizeWake } from '@shared/wake';
import { defaultFiles, defaultRemote, normalizeFiles, normalizeRemote } from '@shared/local-files';
import { DEFAULT_PTT, defaultFollowUp, defaultTtsOut, defaultVad, normalizeFollowUp, normalizeTtsOut, normalizeVad } from '@shared/voice';

const SYSTEM_PROMPT = '당신은 친절한 개인 비서입니다. 한국어로 짧고 명확하게 답하세요.';
export { DEFAULT_PTT };

/** Electron safeStorage 중 여기서 쓰는 부분 (시험에서는 가짜를 넣는다) */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export function defaults(): Settings {
  return {
    version: 2,
    activeProfile: '',
    // 처음 설치하면 AI 프로필도 TTS 서버도 없다. 설정 > AI·TTS에서 직접 만든다
    profiles: {},
    ttsServers: {},
    characterAi: {},
    characterVoice: {},
    charPrefsMigrated: true,
    character: 'sample',
    prevCharacter: '',
    characterOrder: [],
    lockedCharacters: [],
    hiddenCharacters: [],
    alwaysOnTop: false,
    lowSpec: false, // 저사양 모드: 작은 모델·가벼운 목소리 요청, 화면 그리기 줄임
    // stt: 음성 인식 (대화 AI와 따로), vad: 말이 멈추면 자동 전송, followUp: 이어서 대화, ttsOut: 답 읽기 (내장 / TTS 서버)
    voice: { tts: true, autoSend: true, stt: defaultStt(), vad: defaultVad(), followUp: defaultFollowUp(), ttsOut: defaultTtsOut(), wake: defaultWake() },
    shortcut: { ptt: DEFAULT_PTT, ttsToggle: '' }, // 전역 단축키: 말하기, TTS 켜기/끄기(기본 없음)
    mascot: { enabled: false, bounds: null, autoHide: false, hideSec: MASCOT_HIDE.def }, // 바탕화면 캐릭터 창
    tools: { allowedRoots: null, nameMethod: 'local' }, // null = 기본(문서·다운로드·바탕화면)
    files: defaultFiles(), // 삭제한 파일(_to_delete) 비우기, 받은 파일 폴더
    remote: defaultRemote() // 디스코드 봇, 잠금 해제 시간, 보낸 파일 자동 삭제
  };
}

function normalizeProfile(p: unknown): Profile {
  const d = { ...blankProfile(), systemPrompt: SYSTEM_PROMPT, timeoutSec: 60 };
  const out = { ...d, ...(p && typeof p === 'object' ? p : {}) } as Profile;
  if (out.connectionInfo && typeof out.connectionInfo === 'object' && (out.type === 'assistant' || out.type === 'auto')) out.connectionInfo = connectionInfo({ ...out.connectionInfo, provider: 'assistant' } as Health);
  else delete out.connectionInfo;
  if (typeof out.lowSpecModel !== 'string') out.lowSpecModel = '';
  if (!isProviderType(out.type)) out.type = 'ollama'; // v1 설정은 Ollama 직접
  out.temperature = Number.isFinite(Number(out.temperature)) ? Number(out.temperature) : 0.7;
  out.timeoutSec = Math.max(5, Math.min(600, parseInt(String(out.timeoutSec), 10) || 60));
  return out;
}

export function normalize(raw: unknown): Settings {
  const d = defaults();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings> & Record<string, unknown>;
  const s = { ...d, ...r } as Settings;
  s.profiles = {};
  // 프로필은 모두 지울 수 있다 (비면 빈 채로 둔다)
  const src = r.profiles && typeof r.profiles === 'object' ? r.profiles : {};
  for (const [id, p] of Object.entries(src)) s.profiles[id] = normalizeProfile(p);
  if (typeof s.activeProfile !== 'string' || !s.profiles[s.activeProfile]) s.activeProfile = '';
  Object.assign(s, normalizeCharPrefs(r, s.profiles));
  // 처음 설치(설정 파일 없음)는 옮길 것이 없다. 예전 설정 파일은 앱이 캐릭터 목록을 읽은 뒤 한 번 옮긴다
  s.charPrefsMigrated = raw == null ? true : r.charPrefsMigrated === true;
  const rawVoice = (r.voice && typeof r.voice === 'object' ? r.voice : null) as Record<string, unknown> | null;
  s.voice = { ...d.voice, ...(s.voice || {}) };
  s.voice.tts = s.voice.tts !== false;
  s.voice.autoSend = s.voice.autoSend !== false;
  // v0.5 이전 설정: 손 안 대고 대화하려면 바로 보내기가 필요해서, 자동 전송(vad)이 처음 생길 때 한 번 켠다
  if (rawVoice && rawVoice.vad === undefined) s.voice.autoSend = true;
  s.voice.stt = normalizeStt(s.voice.stt);
  s.voice.vad = normalizeVad(s.voice.vad);
  s.voice.followUp = normalizeFollowUp(s.voice.followUp);
  s.voice.ttsOut = normalizeTtsOut(s.voice.ttsOut);
  s.voice.wake = normalizeWake(s.voice.wake, s.voice.vad); // 호출어 소음·말소리 기준이 아직 없으면 음성 대화 값을 한 번 복사
  if (typeof s.character !== 'string' || !s.character) s.character = d.character;
  if (typeof s.prevCharacter !== 'string') s.prevCharacter = '';
  s.lockedCharacters = Array.isArray(s.lockedCharacters) ? [...new Set(s.lockedCharacters.filter((x: unknown): x is string => typeof x === 'string'))] : [];
  s.hiddenCharacters = Array.isArray(s.hiddenCharacters) ? [...new Set(s.hiddenCharacters.filter((x: unknown): x is string => typeof x === 'string'))] : [];
  s.characterOrder = Array.isArray(s.characterOrder) ? [...new Set(s.characterOrder.filter((x: unknown): x is string => typeof x === 'string'))] : [];
  s.lowSpec = !!s.lowSpec;
  s.alwaysOnTop = !!s.alwaysOnTop;
  s.shortcut = { ...d.shortcut, ...(s.shortcut || {}) };
  if (typeof s.shortcut.ptt !== 'string') s.shortcut.ptt = DEFAULT_PTT;
  if (typeof s.shortcut.ttsToggle !== 'string') s.shortcut.ttsToggle = '';
  s.mascot = { ...d.mascot, ...(s.mascot || {}) };
  s.mascot.enabled = !!s.mascot.enabled;
  s.mascot.autoHide = !!s.mascot.autoHide;
  s.mascot.hideSec = normalizeHideSec(s.mascot.hideSec);
  const b = s.mascot.bounds;
  if (!b || ![b.x, b.y].every(Number.isFinite)) s.mascot.bounds = null;
  s.tools = { ...d.tools, ...(s.tools || {}) };
  s.tools.nameMethod = normalizeFileNameMethod(s.tools.nameMethod);
  if (s.tools.allowedRoots != null && !Array.isArray(s.tools.allowedRoots)) s.tools.allowedRoots = null;
  s.files = normalizeFiles(r.files);
  s.remote = normalizeRemote(r.remote);
  s.version = 2;
  return s;
}

export function createStore(file: string, safeStorage: SafeStorageLike | null) {
  const canEncrypt = (): boolean => {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  // 키를 가진 곳: 대화 프로필들, TTS 서버 목록, 음성 인식의 내 서버·클라우드, 예전 TTS 서버, 디스코드 봇 토큰
  type KeyHolder = { apiKey?: string; apiKeyEnc?: string };
  const keyHolders = (raw: unknown): KeyHolder[] => {
    const out: KeyHolder[] = [];
    const r = raw as {
      profiles?: Record<string, KeyHolder>;
      ttsServers?: Record<string, KeyHolder>;
      voice?: { stt?: { server?: KeyHolder; cloud?: KeyHolder }; ttsOut?: { server?: KeyHolder } };
      remote?: { discord?: KeyHolder };
    } | null;
    if (!r || typeof r !== 'object') return out;
    if (r.profiles && typeof r.profiles === 'object') for (const p of Object.values(r.profiles)) if (p && typeof p === 'object') out.push(p);
    if (r.ttsServers && typeof r.ttsServers === 'object') for (const p of Object.values(r.ttsServers)) if (p && typeof p === 'object') out.push(p);
    const stt = r.voice && r.voice.stt;
    if (stt && typeof stt === 'object') for (const h of [stt.server, stt.cloud]) if (h && typeof h === 'object') out.push(h);
    const tts = r.voice && r.voice.ttsOut;
    if (tts && typeof tts === 'object' && tts.server && typeof tts.server === 'object') out.push(tts.server);
    if (r.remote && typeof r.remote === 'object' && r.remote.discord && typeof r.remote.discord === 'object') out.push(r.remote.discord);
    return out;
  };

  function load(): Settings {
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* 처음 실행이거나 파일이 깨짐 → 기본값 */
    }
    for (const h of keyHolders(raw)) {
      if (!h.apiKeyEnc) continue;
      try {
        h.apiKey = canEncrypt() && safeStorage ? safeStorage.decryptString(Buffer.from(h.apiKeyEnc, 'base64')) : '';
      } catch {
        h.apiKey = ''; // 다른 컴퓨터에서 복사한 설정 등 → 다시 입력
      }
      delete h.apiKeyEnc;
    }
    return normalize(raw);
  }

  function save(settings: Settings): Settings {
    const s = normalize(JSON.parse(JSON.stringify(settings)));
    const disk = JSON.parse(JSON.stringify(s)) as unknown;
    for (const h of keyHolders(disk)) {
      if (h.apiKey && canEncrypt() && safeStorage) {
        h.apiKeyEnc = safeStorage.encryptString(h.apiKey).toString('base64');
        delete h.apiKey;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(disk, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file); // 쓰다가 꺼져도 설정이 깨지지 않게
    return s;
  }

  return { load, save, file, encrypted: canEncrypt };
}

export type SettingsStore = ReturnType<typeof createStore>;
