// 음성 대화(말이 멈추면 자동 전송, 이어서 대화)와 답 읽기(TTS) 설정의 기본값·정리. 메인과 화면이 같이 쓴다.
import type { FollowUpSettings, Health, Settings, TtsOutSettings, VadSettings } from './types';

/** 말하기 단축키 기본값 */
export const DEFAULT_PTT = 'CommandOrControl+Shift+Space';

export const VAD_LIMITS = { silenceMin: 1, silenceMax: 3, noSpeechMin: 0.5, noSpeechMax: 15, noiseMin: -100, noiseMax: -10, marginMin: 6, marginMax: 25, marginDefault: 12, spokenMin: 0, spokenMax: 2, spokenDefault: 0.3 } as const;
/** 최소 말소리 길이는 0.1초 단위 */
export const SPOKEN_STEP = 0.1;
export const FOLLOW_LIMITS = { waitMin: 3, waitMax: 15 } as const;
/** 시간 설정은 0.5초 단위 */
export const SEC_STEP = 0.5;
/** 0.5초 단위로 맞추고 범위 안으로 (숫자가 아니면 d) */
export const halfSec = (v: unknown, d: number, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, Math.round(n / SEC_STEP) * SEC_STEP));
};

/** step 단위로 맞추고 범위 안으로 (숫자가 아니면 d). 0.1 단위 소수 오차는 정리한다 */
export const stepSec = (v: unknown, d: number, lo: number, hi: number, step: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, Math.round(Math.round(n / step) * step * 10) / 10));
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d: number, lo: number, hi: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function defaultVad(): VadSettings {
  return { autoStop: true, silenceSec: 1.5, noSpeechSec: 5, noiseDb: null, marginDb: VAD_LIMITS.marginDefault, minSpokenSec: VAD_LIMITS.spokenDefault };
}

export function normalizeVad(raw: unknown): VadSettings {
  const d = defaultVad();
  const r = isObj(raw) ? raw : {};
  const nz = r.noiseDb;
  // 예전 thresholdDb(고정 말소리 기준)는 재는 방식이 달라서 버린다 → 마이크 맞추기를 다시 하거나, 듣기 시작할 때 잠깐 잰다
  return {
    autoStop: typeof r.autoStop === 'boolean' ? r.autoStop : d.autoStop,
    silenceSec: halfSec(r.silenceSec, d.silenceSec, VAD_LIMITS.silenceMin, VAD_LIMITS.silenceMax),
    noSpeechSec: halfSec(r.noSpeechSec, d.noSpeechSec, VAD_LIMITS.noSpeechMin, VAD_LIMITS.noSpeechMax),
    noiseDb: nz === null || nz === undefined || nz === '' || !Number.isFinite(Number(nz)) ? null : Math.round(num(nz, -60, VAD_LIMITS.noiseMin, VAD_LIMITS.noiseMax)),
    marginDb: Math.round(num(r.marginDb, d.marginDb, VAD_LIMITS.marginMin, VAD_LIMITS.marginMax)),
    minSpokenSec: stepSec(r.minSpokenSec, d.minSpokenSec, VAD_LIMITS.spokenMin, VAD_LIMITS.spokenMax, SPOKEN_STEP)
  };
}

export function defaultFollowUp(): FollowUpSettings {
  return { enabled: true, waitSec: 6, endChime: true };
}

export function normalizeFollowUp(raw: unknown): FollowUpSettings {
  const d = defaultFollowUp();
  const r = isObj(raw) ? raw : {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    waitSec: halfSec(r.waitSec, d.waitSec, FOLLOW_LIMITS.waitMin, FOLLOW_LIMITS.waitMax),
    endChime: typeof r.endChime === 'boolean' ? r.endChime : d.endChime
  };
}

export function defaultTtsOut(): TtsOutSettings {
  return { source: 'builtin', fallbackBuiltin: true, volume: 100, builtin: { voice: '', rate: 1 }, server: { baseUrl: '', apiKey: '', voice: '', model: '' } };
}

export function normalizeTtsOut(raw: unknown): TtsOutSettings {
  const d = defaultTtsOut();
  const r = isObj(raw) ? raw : {};
  const b = isObj(r.builtin) ? r.builtin : {};
  const s = isObj(r.server) ? r.server : {};
  return {
    source: r.source === 'server' ? 'server' : 'builtin',
    fallbackBuiltin: typeof r.fallbackBuiltin === 'boolean' ? r.fallbackBuiltin : d.fallbackBuiltin,
    volume: Math.round(num(r.volume, d.volume, 0, 100)),
    builtin: { voice: typeof b.voice === 'string' ? b.voice : '', rate: Math.round(num(b.rate, 1, 0.5, 2) * 10) / 10 },
    server: { baseUrl: str(s.baseUrl).replace(/\/+$/, ''), apiKey: str(s.apiKey), voice: str(s.voice), model: str(s.model) }
  };
}

/**
 * 서버 목소리를 쓸 수 있는지 (설정만 보고). 주소를 넣었으면 일단 시도하고,
 * 비웠으면 대화 서버가 TTS를 지원한다고 답했을 때만.
 */
export function ttsServerReady(s: Settings, health: Health | null): boolean {
  const t = s.voice.ttsOut;
  if (t.server.baseUrl) return true;
  return !!(health && health.features.tts);
}

/** 지금 답을 소리로 읽을 수 있는지 (읽기 켜짐 + 내장이거나 서버가 되거나 내장으로 넘어가기) */
export function ttsActive(s: Settings, health: Health | null, builtinAvailable: boolean): boolean {
  if (!s.voice.tts) return false;
  const t = s.voice.ttsOut;
  if (t.source === 'builtin') return builtinAvailable;
  return ttsServerReady(s, health) || (t.fallbackBuiltin && builtinAvailable);
}
