// 음성 인식 설정의 기본값·이름과 "지금 🎤를 쓸 수 있는가" 판단. 메인과 화면이 같이 쓴다.
import type { Health, LocalSttModel, Profile, Settings, SttSettings, SttSourceId } from './types';

export const STT_SOURCES: SttSourceId[] = ['server', 'cloud', 'local'];
export const LOCAL_MODELS: LocalSttModel[] = ['tiny', 'base', 'small', 'medium'];

export const LOCAL_MODEL_INFO: Record<LocalSttModel, { label: string; size: string }> = {
  tiny: { label: 'tiny (가장 빠름, 한국어 부정확)', size: '약 40MB' },
  base: { label: 'base (빠름)', size: '약 80MB' },
  small: { label: 'small (권장)', size: '약 250MB' },
  medium: { label: 'medium (정확, 느림)', size: '약 800MB' }
};

export function defaultStt(): SttSettings {
  return {
    order: ['server', 'cloud', 'local'],
    server: { enabled: true, baseUrl: '', apiKey: '', model: '' },
    cloud: { enabled: false, provider: 'gemini', apiKey: '', model: '' },
    local: { enabled: false, model: 'small' },
    timeoutSec: 8
  };
}

export function normalizeStt(raw: unknown): SttSettings {
  const d = defaultStt();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SttSettings>;
  const obj = <T extends object>(v: unknown, def: T): T => ({ ...def, ...(v && typeof v === 'object' ? (v as Partial<T>) : {}) });
  const order = Array.isArray(r.order) ? r.order.filter((x): x is SttSourceId => STT_SOURCES.includes(x as SttSourceId)) : [];
  const out: SttSettings = {
    order: [...new Set([...order, ...d.order])], // 빠진 것은 뒤에 붙인다
    server: obj(r.server, d.server),
    cloud: obj(r.cloud, d.cloud),
    local: obj(r.local, d.local),
    timeoutSec: Math.max(3, Math.min(60, parseInt(String(r.timeoutSec), 10) || d.timeoutSec))
  };
  for (const k of ['baseUrl', 'apiKey', 'model'] as const) out.server[k] = String(out.server[k] || '').trim();
  for (const k of ['apiKey', 'model'] as const) out.cloud[k] = String(out.cloud[k] || '').trim();
  out.server.enabled = !!out.server.enabled;
  out.cloud.enabled = !!out.cloud.enabled;
  out.local.enabled = !!out.local.enabled;
  if (out.cloud.provider !== 'gemini' && out.cloud.provider !== 'openai') out.cloud.provider = 'gemini';
  if (!LOCAL_MODELS.includes(out.local.model)) out.local.model = 'small';
  return out;
}

export const isCloudProfile = (p: Pick<Profile, 'type' | 'baseUrl'> | undefined): boolean =>
  !!p && (p.type === 'anthropic' || p.type === 'gemini' || (p.type === 'openai' && /api\.openai\.com/i.test(p.baseUrl)));

/** 클라우드 키를 비웠을 때 쓸 대화 프로필 (같은 회사, 키가 있는 것) */
export function cloudKeyProfile(settings: Pick<Settings, 'profiles' | 'activeProfile'>, provider: SttSettings['cloud']['provider']): Profile | null {
  const match = (p: Profile) => (provider === 'gemini' ? p.type === 'gemini' : p.type === 'openai' && /api\.openai\.com/i.test(p.baseUrl));
  const active = settings.profiles[settings.activeProfile];
  if (active && match(active) && active.apiKey) return active;
  return Object.values(settings.profiles).find((p) => match(p) && !!p.apiKey) || null;
}

export const SOURCE_LABEL: Record<SttSourceId, string> = { server: '내 서버 / 로컬', cloud: '클라우드', local: '이 컴퓨터' };
export const cloudLabel = (p: SttSettings['cloud']['provider']) => `클라우드 (${p === 'gemini' ? 'Gemini' : 'ChatGPT'})`;

export interface SourceReady {
  id: SttSourceId;
  ready: boolean;
  /** 안 될 때 이유, 될 때 설명 */
  note: string;
}

/**
 * 🎤를 쓸 수 있는지 판단한다. 실제로 되는지는 보내 봐야 알지만, 설정만으로 확실히 안 되는 곳은 거른다.
 * chatHealth: 대화 서버 연결 확인 결과 (주소를 비운 "내 서버"는 대화 서버의 음성 인식을 쓴다)
 */
export function sttReadiness(
  settings: Pick<Settings, 'profiles' | 'activeProfile'> & { voice: { stt: SttSettings } },
  chatHealth: Pick<Health, 'features'> | null,
  localDownloaded: LocalSttModel[]
): { ready: boolean; sources: SourceReady[] } {
  const stt = settings.voice.stt;
  const chat = settings.profiles[settings.activeProfile];
  const sources = stt.order.map((id): SourceReady => {
    if (id === 'server') {
      if (!stt.server.enabled) return { id, ready: false, note: '꺼짐' };
      if (stt.server.baseUrl) return { id, ready: true, note: stt.server.baseUrl };
      if (isCloudProfile(chat)) return { id, ready: false, note: '주소가 비어 있고 대화 AI가 클라우드라서 쓸 수 없음' };
      if (chatHealth && chatHealth.features.stt) return { id, ready: true, note: '대화 서버의 음성 인식' };
      return { id, ready: false, note: '대화 서버가 음성 인식을 지원하지 않음 (주소를 따로 넣으세요)' };
    }
    if (id === 'cloud') {
      if (!stt.cloud.enabled) return { id, ready: false, note: '꺼짐' };
      if (stt.cloud.apiKey || cloudKeyProfile(settings, stt.cloud.provider)) return { id, ready: true, note: cloudLabel(stt.cloud.provider) };
      return { id, ready: false, note: 'API 키가 없음' };
    }
    if (!stt.local.enabled) return { id, ready: false, note: '꺼짐' };
    if (localDownloaded.includes(stt.local.model)) return { id, ready: true, note: `위스퍼 ${stt.local.model}` };
    return { id, ready: false, note: `모델(${stt.local.model})을 아직 받지 않음` };
  });
  return { ready: sources.some((s) => s.ready), sources };
}
