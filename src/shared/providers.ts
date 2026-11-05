// 서버 종류별 기본값과 안내 문구. 메인(설정 기본값)과 화면(설정 창)이 같이 쓴다.
import type { ProviderType } from './types';

export interface ProviderInfo {
  label: string;
  /** 새로 고를 때 채워 주는 주소 */
  baseUrl: string;
  urlPlaceholder: string;
  keyLabel: string;
  /** 대화 내용이 외부 회사 서버로 나가는지 */
  cloud: boolean;
  /** 모델·프롬프트·Temperature를 앱에서 정하는 종류 (비서 서버는 서버가 정함) */
  direct: boolean;
  keyHelp?: string;
}

/** 설정 창에서 고르는 모양. 클라우드 3종은 키만, 내 서버는 주소(+키) */
export type Choice = 'openai' | 'anthropic' | 'gemini' | 'own' | 'assistant';

export const OFFICIAL_OPENAI = 'https://api.openai.com/v1';

export function choiceOf(type: ProviderType, baseUrl: string): Choice {
  if (type === 'anthropic' || type === 'gemini') return type;
  if (type === 'openai' && /api\.openai\.com/i.test(baseUrl)) return 'openai';
  if (type === 'assistant') return 'assistant';
  return 'own'; // auto, ollama, 호환 서버
}

export const CHOICE_LABEL: Record<Choice, string> = {
  openai: 'ChatGPT (OpenAI)',
  anthropic: 'Claude (Anthropic)',
  gemini: 'Gemini (Google)',
  own: 'Ollama / LM Studio 등 (자동 인식)',
  assistant: '내 서버'
};

export const PROVIDER_INFO: Record<ProviderType, ProviderInfo> = {
  auto: {
    label: 'Ollama / LM Studio 등 (자동 인식)',
    baseUrl: 'http://localhost:11434',
    urlPlaceholder: 'http://localhost:11434  (LM Studio: …:1234, Open WebUI: …:3011)',
    keyLabel: 'API 키 (서버가 요구할 때만)',
    cloud: false,
    direct: true
  },
  assistant: {
    label: '내 서버',
    baseUrl: '',
    urlPlaceholder: 'https://서버주소  (입구가 다르면 https://서버주소/ai-agent)',
    keyLabel: 'API 키',
    cloud: false,
    direct: false
  },
  ollama: {
    label: 'Ollama (로컬 또는 다른 PC)',
    baseUrl: 'http://localhost:11434',
    urlPlaceholder: 'http://localhost:11434',
    keyLabel: 'API 키 (프록시 인증을 쓸 때만)',
    cloud: false,
    direct: true
  },
  openai: {
    label: 'ChatGPT / OpenAI 호환 (LM Studio, vLLM 등)',
    baseUrl: 'https://api.openai.com/v1',
    urlPlaceholder: 'https://api.openai.com/v1  (LM Studio: http://localhost:1234/v1)',
    keyLabel: 'API 키 (platform.openai.com 에서 발급)',
    cloud: true,
    direct: true
  },
  anthropic: {
    label: 'Claude (Anthropic)',
    baseUrl: 'https://api.anthropic.com',
    urlPlaceholder: 'https://api.anthropic.com',
    keyLabel: 'API 키 (console.anthropic.com 에서 발급)',
    cloud: true,
    direct: true
  },
  gemini: {
    label: 'Gemini (Google)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    urlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
    keyLabel: 'API 키 (aistudio.google.com 에서 발급)',
    cloud: true,
    direct: true
  }
};

export const isProviderType = (v: unknown): v is ProviderType => typeof v === 'string' && v in PROVIDER_INFO;
