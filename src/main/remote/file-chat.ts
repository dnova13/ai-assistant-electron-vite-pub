// 비서 봇의 자연어도 같은 비서 API로 해석하고, 실행은 반드시 해당 원격 허브에 맡긴다.
import type { ActionArgs, ActionReport, ChatEvent } from '@shared/types';
import { normalizeFileText } from '@shared/commands';
import type { ChatCall, ProfileLike } from '../api/client';

interface FileChatOptions {
  character?: { id: string; persona: string };
  profile: ProfileLike | null;
  chat: (profile: ProfileLike, req: ChatCall, onEvent: (ev: ChatEvent) => void) => Promise<void>;
  runAction: (id: string, action: string, args: ActionArgs) => Promise<ActionReport>;
  reportAction: (profile: ProfileLike, id: string, result: ActionReport) => Promise<void>;
}

/** 문자열은 대화 답, void는 허브가 실행 결과를 이미 보냈다는 뜻이다. */
export async function serverFileChat(text: string, o: FileChatOptions): Promise<string | void> {
  const profile = o.profile;
  if (!profile || profile.type !== 'assistant') throw new Error('등록에 쓴 내 서버 프로필을 찾지 못했습니다.');
  let answer = '';
  let error = '';
  const actions: Extract<ChatEvent, { type: 'client_action' }>[] = [];
  await o.chat(profile, { text: normalizeFileText(text), input: 'text', ...(o.character ? { session: o.character.id, client: { character: o.character.id, persona: o.character.persona } } : {}) }, (ev) => {
    if (ev.type === 'delta') answer += ev.text;
    else if (ev.type === 'done' && !answer && ev.text) answer = ev.text;
    else if (ev.type === 'client_action') actions.push(ev);
    else if (ev.type === 'error') error = ev.message;
    else if (ev.type === 'confirm') error = '이 경로에서는 앱의 파일 작업만 처리합니다.';
  });
  // 응답 도중 오류가 나면 미완성 해석으로 실행하지 않는다.
  if (error) throw new Error(error);
  if (actions.length > 1) throw new Error('파일 작업은 한 번에 하나씩 요청해 주세요.');
  if (!actions.length) return answer;
  const ev = actions[0];
  const result = await o.runAction(ev.id, ev.action, ev.args);
  try {
    await o.reportAction(profile, ev.id, result);
  } catch {
    // 실행 결과는 이미 사용자에게 보냈다. 보고 실패를 실행 실패로 바꾸지 않는다.
    console.warn('비서 봇 파일 작업 결과 보고 실패');
  }
}
