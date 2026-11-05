// 답을 소리로 읽기: TTS 서버에서 소리를 받아 온다. (이 컴퓨터 내장 목소리는 화면 쪽에서 읽는다)
// 주소를 비우면 대화 서버의 TTS(규약 v1). 주소를 넣으면 규약 v1(/v1/tts)인지 OpenAI 호환(/v1/audio/speech)인지 알아낸다.
import type { Profile, Settings, TtsOutSettings, TtsServerTest } from '@shared/types';
import * as api from './api/client';

const cleanBase = (u: string) => String(u || '').trim().replace(/\/+$/, '');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : isObj(x) ? String(x.id || x.name || '') : '')).filter(Boolean) : []);

type ServerCfg = TtsOutSettings['server'];

/* ---------------- 서버 종류 알아보기 ---------------- */

const detectCache = new Map<string, { at: number; found: TtsServerTest }>();

/** 공식 OpenAI는 목록에 대화 모델도 섞여 있어서 TTS 모델만 남긴다 */
function ttsModels(base: string, models: string[]): string[] {
  if (/api\.openai\.com/i.test(base)) return models.filter((m) => /tts/i.test(m)).sort();
  return models;
}

/**
 * 규약 v1 서버(/v1/health 의 features.tts)인지, OpenAI 호환 TTS 서버(/v1/models)인지 알아본다.
 * OpenAI 호환 서버가 목소리 목록(/v1/audio/voices)을 주면 같이 돌려준다.
 */
export async function detectServer(cfg: Pick<ServerCfg, 'baseUrl' | 'apiKey'>): Promise<TtsServerTest> {
  const base = cleanBase(cfg.baseUrl);
  if (!/^https?:\/\//i.test(base)) throw new api.ApiError('주소는 http:// 또는 https:// 로 시작해야 합니다.', 'bad_url');
  const root = base.replace(/\/v1$/i, '');
  const p = (b: string): api.ProfileLike => ({ type: 'assistant', baseUrl: b, apiKey: cfg.apiKey });
  let authSeen = false;
  const probe = async (b: string, path: string) => {
    try {
      return await api.getJson(p(b), path);
    } catch (e) {
      if (e instanceof api.ApiError && e.code === 'auth') authSeen = true;
      return null;
    }
  };
  const h = await probe(root, '/v1/health');
  if (h && isObj(h.features)) {
    if (h.features.tts) return { kind: 'v1', voices: strs(h.tts_voices), models: [] };
    throw new api.ApiError('이 서버(규약 v1)는 목소리 읽기(TTS)를 지원하지 않는다고 답했습니다.', 'unsupported');
  }
  const m = await probe(root + '/v1', '/models');
  if (m && Array.isArray(m.data)) {
    const v = await probe(root + '/v1', '/audio/voices');
    const voices = v ? strs(v.voices || v.data) : [];
    return { kind: 'openai', voices, models: ttsModels(root, strs(m.data)) };
  }
  if (authSeen) throw new api.ApiError('인증 실패: TTS 서버의 키를 확인하세요.', 'auth');
  throw new api.ApiError('이 주소에서 TTS 서버를 찾지 못했습니다 (규약 v1 /v1/health, OpenAI 호환 /v1/models 를 찾아봤습니다).', 'unreachable');
}

async function serverKind(cfg: ServerCfg): Promise<TtsServerTest> {
  const key = cleanBase(cfg.baseUrl) + '|' + (cfg.apiKey ? 'k' : '');
  const hit = detectCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.found;
  const found = await detectServer(cfg);
  detectCache.set(key, { at: Date.now(), found });
  return found;
}

/** 시험용: 알아 둔 서버 종류를 지운다 */
export function clearCache(): void {
  detectCache.clear();
}

/** OpenAI 호환 서버에서 쓸 모델: 설정 → TTS처럼 보이는 모델 → 첫 모델 → tts-1 */
function pickModel(cfg: ServerCfg, found: TtsServerTest): string {
  if (cfg.model) return cfg.model;
  const prefer = ['gpt-4o-mini-tts', 'tts-1'].find((m) => found.models.includes(m));
  return prefer || found.models.find((m) => /tts|speech/i.test(m)) || found.models[0] || 'tts-1';
}

/* ---------------- 소리 만들기 ---------------- */

export interface SynthDeps {
  settings: Settings;
  chatProfile: Profile;
  /** 설정 창의 미리 듣기처럼 편집 중인 값을 쓸 때 */
  server?: ServerCfg;
}

/**
 * 글 → 소리. 목소리는 설정의 목소리 → 캐릭터 목소리 → 서버 기본 순서로 정한다.
 * characterVoice: 캐릭터 config.voice.voice (없으면 'default')
 */
export async function synthesize(text: string, characterVoice: string, deps: SynthDeps): Promise<{ audio: Buffer; mime: string }> {
  const cfg = deps.server || deps.settings.voice.ttsOut.server;
  const charVoice = characterVoice && characterVoice !== 'default' ? characterVoice : '';
  const lowSpec = deps.settings.lowSpec;
  if (!cfg.baseUrl) return api.tts(deps.chatProfile, text, cfg.voice || charVoice || 'default', lowSpec); // 대화 서버의 TTS
  const found = await serverKind(cfg);
  const root = cleanBase(cfg.baseUrl).replace(/\/v1$/i, '');
  if (found.kind === 'v1') return api.tts({ type: 'assistant', baseUrl: root + '/v1', apiKey: cfg.apiKey }, text, cfg.voice || charVoice || 'default', lowSpec);
  const voice = cfg.voice || charVoice || found.voices[0] || 'alloy';
  return api.speech({ type: 'openai', baseUrl: root + '/v1', apiKey: cfg.apiKey }, text, voice, pickModel(cfg, found));
}
