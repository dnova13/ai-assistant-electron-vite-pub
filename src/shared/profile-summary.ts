// 접속 시험에서 확인한 표시 정보. 실제 주소·키는 이 정보에 복제하지 않는다.
import type { Health, Profile } from './types';
import { choiceOf } from './providers';
import { geminiLabel } from './gemini-models';

export type ConnectionInfo = { server: string; version: string; model: string };
export const sameConnection = (a: Profile, b: Profile): boolean => a.type === b.type && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey;
export function patchProfile(p: Profile, patch: Partial<Profile>): Profile {
  const next = { ...p, ...patch };
  if (!sameConnection(p, next)) delete next.connectionInfo;
  return next;
}
export function connectionInfo(h: Health): ConnectionInfo | undefined {
  if (h.provider !== 'assistant') return undefined;
  const clean = (s: unknown) => typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 256) : '';
  return { server: clean(h.server), version: clean(h.version), model: clean(h.model) };
}
export function profileSub(p: Profile): string {
  const c = choiceOf(p.type, p.baseUrl);
  if (c === 'assistant' || (p.type === 'auto' && p.connectionInfo)) {
    const h = p.connectionInfo;
    return ['내 서버', h && [h.server, h.version].filter(Boolean).join(' '), h?.model && `모델 ${h.model}`].filter(Boolean).join(' · ');
  }
  const kind = c === 'openai' ? 'ChatGPT' : c === 'anthropic' ? 'Claude' : c === 'gemini' ? 'Gemini' : p.type === 'ollama' ? 'Ollama' : 'Ollama / LM Studio 등';
  return `${kind} · ${p.model ? (p.type === 'gemini' ? geminiLabel(p.model) : p.model) : '모델 미선택'}`;
}
