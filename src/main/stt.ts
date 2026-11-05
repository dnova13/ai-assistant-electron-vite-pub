// 음성 인식: 설정의 순서(내 서버 → 클라우드 → 이 컴퓨터)대로 시도하고, 실패하거나 시간이 지나면 다음으로 넘어간다.
// 대화 AI와 따로 고른다.
import type { LocalSttModel, Profile, Settings, SttFailure, SttResult, SttServerTest, SttSettings, SttSourceId } from '@shared/types';
import { cleanTranscript } from '@shared/transcript';
import { OFFICIAL_OPENAI, PROVIDER_INFO } from '@shared/providers';
import { SOURCE_LABEL, cloudKeyProfile, cloudLabel, isCloudProfile } from '@shared/stt';
import * as api from './api/client';

/** 앱 안 위스퍼 (stt-local.ts). 시험에서는 가짜를 넣는다 */
export interface LocalEngine {
  isReady(model: LocalSttModel): boolean;
  transcribe(wav: Buffer, model: LocalSttModel): Promise<string>;
}

const LOCAL_TIMEOUT_MS = 180_000; // 이 컴퓨터는 느릴 수 있어서 넉넉히

const cleanBase = (u: string) => String(u || '').trim().replace(/\/+$/, '');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/* ---------------- 내 서버: 종류 알아보기 ---------------- */

const detectCache = new Map<string, { at: number; found: SttServerTest }>();

/**
 * 규약 v1 서버(/v1/health 의 features.stt)인지, OpenAI 호환 음성 인식 서버(/v1/models)인지 알아본다.
 * 규약 서버가 음성 인식이 없다고 답하면 그대로 알려 준다.
 */
export async function detectServer(cfg: Pick<SttSettings['server'], 'baseUrl' | 'apiKey'>): Promise<SttServerTest> {
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
    if (h.features.stt) return { kind: 'v1', models: [] };
    throw new api.ApiError('이 서버(규약 v1)는 음성 인식을 지원하지 않는다고 답했습니다.', 'unsupported');
  }
  const m = await probe(root + '/v1', '/models');
  if (m && Array.isArray(m.data)) {
    const models = m.data.map((x) => (isObj(x) ? String(x.id || '') : '')).filter(Boolean);
    return { kind: 'openai', models };
  }
  if (authSeen) throw new api.ApiError('인증 실패: 음성 인식 서버의 키를 확인하세요.', 'auth');
  throw new api.ApiError('이 주소에서 음성 인식 서버를 찾지 못했습니다 (규약 v1 /v1/health, OpenAI 호환 /v1/models 를 찾아봤습니다).', 'unreachable');
}

async function serverKind(cfg: SttSettings['server']): Promise<SttServerTest> {
  const key = cleanBase(cfg.baseUrl) + '|' + (cfg.apiKey ? 'k' : '');
  const hit = detectCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.found;
  const found = await detectServer(cfg);
  detectCache.set(key, { at: Date.now(), found });
  return found;
}

/* ---------------- 클라우드: 키·모델 고르기 ---------------- */

function cloudProfile(settings: Settings, cfg: SttSettings['cloud']): api.ProfileLike {
  const keyFrom = cloudKeyProfile(settings, cfg.provider);
  const apiKey = cfg.apiKey || (keyFrom ? keyFrom.apiKey : '');
  if (!apiKey) throw new api.ApiError(`${cloudLabel(cfg.provider)} API 키가 없습니다. 설정 > 음성에 넣거나 같은 회사의 대화 프로필에 넣으세요.`, 'auth');
  if (cfg.provider === 'gemini') {
    const model = cfg.model || (keyFrom && keyFrom.type === 'gemini' ? keyFrom.model : '');
    if (!model) throw new api.ApiError('Gemini 음성 인식 모델을 고르세요 (설정 > 음성 > 클라우드 > 연결 테스트).', 'no_model');
    return { type: 'gemini', baseUrl: (keyFrom && keyFrom.baseUrl) || PROVIDER_INFO.gemini.baseUrl, apiKey, model };
  }
  return { type: 'openai', baseUrl: OFFICIAL_OPENAI, apiKey, sttModel: cfg.model || 'whisper-1' };
}

export async function testCloud(settings: Settings, cfg: SttSettings['cloud']): Promise<{ models: string[] }> {
  const p = cloudProfile(settings, { ...cfg, model: cfg.model || 'x' }); // 모델은 목록을 받으려고 임시로 채운다
  // ChatGPT는 음성 인식 전용 모델만 보여 준다 (목록에 없으면 기본 whisper-1)
  if (cfg.provider === 'openai') {
    const list = await api.getJson<{ data?: { id?: string }[] }>(p, '/models', 8000);
    const ids = (list.data || []).map((m) => String(m.id || '')).filter((id) => /whisper|transcribe/i.test(id));
    return { models: ids.length ? ids.sort() : ['whisper-1'] };
  }
  return { models: (await api.health({ ...p, model: '' })).models };
}

/* ---------------- 순서대로 시도 ---------------- */

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new api.ApiError(`${what}: ${Math.round(ms / 1000)}초 안에 답이 없습니다.`, 'timeout')), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

export interface TranscribeDeps {
  settings: Settings;
  chatProfile: Profile;
  local: LocalEngine | null;
}

function sourceLabel(id: SttSourceId, stt: SttSettings): string {
  return id === 'cloud' ? cloudLabel(stt.cloud.provider) : SOURCE_LABEL[id];
}

/** 한 곳에서 인식한다. 쓸 수 없는 곳이면 null (건너뜀) */
async function trySource(id: SttSourceId, audio: Buffer, mime: string, deps: TranscribeDeps): Promise<string | null> {
  const stt = deps.settings.voice.stt;
  const ms = stt.timeoutSec * 1000;
  if (id === 'server') {
    if (!stt.server.enabled) return null;
    if (!stt.server.baseUrl) {
      // 주소를 비우면 대화 서버의 음성 인식을 쓴다. 대화 AI가 클라우드면 음성이 밖으로 나가므로 쓰지 않는다
      if (isCloudProfile(deps.chatProfile)) return null;
      return (await withTimeout(api.stt(deps.chatProfile, audio, mime), ms, '대화 서버')).text;
    }
    const kind = await withTimeout(serverKind(stt.server), ms, '내 서버');
    const base = cleanBase(stt.server.baseUrl);
    const p: api.ProfileLike =
      kind.kind === 'v1'
        ? { type: 'assistant', baseUrl: base.replace(/\/v1$/i, '') + '/v1', apiKey: stt.server.apiKey }
        : { type: 'openai', baseUrl: base.replace(/\/v1$/i, '') + '/v1', apiKey: stt.server.apiKey, sttModel: stt.server.model || kind.models[0] || 'whisper-1' };
    return (await withTimeout(api.stt(p, audio, mime), ms, '내 서버')).text;
  }
  if (id === 'cloud') {
    if (!stt.cloud.enabled) return null;
    return (await withTimeout(api.stt(cloudProfile(deps.settings, stt.cloud), audio, mime), ms, cloudLabel(stt.cloud.provider))).text;
  }
  if (!stt.local.enabled || !deps.local) return null;
  if (!deps.local.isReady(stt.local.model)) throw new api.ApiError(`이 컴퓨터용 위스퍼 모델(${stt.local.model})을 아직 받지 않았습니다 (설정 > 음성).`, 'no_model');
  return withTimeout(deps.local.transcribe(audio, stt.local.model), LOCAL_TIMEOUT_MS, '이 컴퓨터');
}

/**
 * 설정 순서대로 시도한다. 성공한 곳과, 그 전에 실패한 곳들을 돌려준다.
 * 모두 실패하면 이유를 모아 오류로 던진다.
 */
export async function transcribe(audio: Buffer, mime: string, deps: TranscribeDeps): Promise<SttResult> {
  const stt = deps.settings.voice.stt;
  const failures: SttFailure[] = [];
  for (const id of stt.order) {
    const label = sourceLabel(id, stt);
    let text: string | null;
    try {
      text = await trySource(id, audio, mime, deps);
    } catch (e) {
      failures.push({ source: id, label, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (text === null) continue; // 꺼져 있거나 쓸 수 없는 곳
    // 같은 말을 끝없이 반복한 결과(조용한 소리에서 위스퍼가 지어냄)는 줄이거나 버린다
    return { text: cleanTranscript(text), source: id, label, failures };
  }
  if (!failures.length) throw new api.ApiError('켜진 음성 인식이 없습니다. 설정 > 음성에서 하나 이상 켜세요.', 'unsupported');
  throw new api.ApiError(`음성 인식에 실패했습니다.\n${failures.map((f) => `· ${f.label}: ${f.message}`).join('\n')}`, failures[failures.length - 1].source === 'local' ? 'local_failed' : 'stt_failed');
}
