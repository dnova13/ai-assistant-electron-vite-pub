// "파일 <동작> ...", "!파일 <동작> ..." 명령 해석. 서버에 보내지 않고 앱이 직접 처리한다 (코드가 해석, 모델 안 씀).
// 앱 입력창과 메신저(디스코드)가 같은 해석을 쓴다.
import type { ActionArgs, ActionName } from './types';

export const ACTION_NAMES: Record<ActionName, string> = {
  'file.search': '찾기',
  'file.open': '열기',
  'file.reveal': '위치 보기',
  'file.move': '이동',
  'file.copy': '복사',
  'file.rename': '이름 바꾸기',
  'file.mkdir': '폴더 만들기',
  'file.create': '파일 만들기',
  'file.list': '목록',
  'file.backup': '백업',
  'file.delete': '삭제',
  'file.send': '보내기'
};

export const SUPPORTED_ACTIONS = Object.keys(ACTION_NAMES) as ActionName[];
export const isSupportedAction = (a: string): a is ActionName => (SUPPORTED_ACTIONS as string[]).includes(a);

const HELP_BODY = `  파일 찾기 [위치] <이름>
  파일 열기 [위치] <이름>
  파일 위치 [위치] <이름> — Finder/탐색기에서 보기
  파일 이동 [출발 위치] <이름> <도착 폴더>
  파일 복사 [출발 위치] <이름> [도착 폴더 또는 새 이름]
  파일 이름 [위치] <이름> <새 이름> — 이름 바꾸기
  파일 이름변경 [위치] <이름> <새 이름> — 같은 동작
  파일 폴더 생성 <위치> <새 폴더>
  파일 생성 <위치> <이름> — 빈 파일 만들기
  파일 목록 — 허용 폴더 이름·경로 보기
  파일 목록 <폴더> — 지정 폴더 안의 내용 보기
  파일 백업 [위치] <이름> — backup 폴더에 날짜 사본 만들기
  파일 삭제 [위치] <이름> — _to_delete 폴더로 옮기기`;

const HELP_DETAILS = `- 위치와 경로

  경로는 위치와 같은 뜻입니다.
  찾기·위치는 지정 폴더와 하위까지 찾습니다.
  나머지 작업은 지정 폴더 바로 안에서 대상을 찾습니다.
  대상 파일을 찾을 위치를 생략하면 전체 허용 범위에서 찾습니다.
  파일 목록에 위치를 생략하면 허용 폴더 목록을 보여 줍니다.
  예: 파일 백업 바탕화면 메모.txt

- 공백 있는 이름

  위치와 이름을 "따옴표"로 묶으면 그 경계를 우선합니다.
  생성은 실제 위치를 찾아 공백 있는 새 이름도 받습니다.
  위치나 이름이 모호하면 후보를 선택합니다.

- 생성과 복사

  생성·등록·추가·만들기는 같은 동작입니다.
  새 파일은 확장자가 없거나 .txt인 빈 파일만 만듭니다.
  파일 복사 <이름>은 같은 폴더에 번호를 붙인 사본을 만듭니다.
  새 이름과 도착 폴더가 모호하면 후보를 선택합니다.

- 확인

  이동·복사·이름 바꾸기·백업은 한 번 확인합니다.
  삭제는 두 번 확인합니다.`;

export const LOCAL_HELP = `- 파일 명령 (서버 없이 이 컴퓨터에서 처리, 허용 폴더 안에서만)
${HELP_BODY}

${HELP_DETAILS}

- 대화 기록

  /clear — 선택한 캐릭터의 앱 대화 비우기
  기존 기록은 _to_delete에 보관하며 서버의 대화 기억은 별도입니다.

- 안내

  !파일 …도 같습니다.
  파일 보내기는 메신저(디스코드)에서만 됩니다.`;

export const REMOTE_HELP = `- 파일 명령 (이 컴퓨터의 원격 허용 폴더 안에서만)
${HELP_BODY}
  파일 보내기 [위치] <이름> — 이 대화방으로 보내기

- 인증·잠금

  인증 / 인증 도움말 — 인증 방법 안내
  인증 <6자리 코드> — 잠금 풀기
  인증 폐기 / 잠금 — 현재 인증 종료 (키는 유지)
  복구 <복구 코드> — 인증 앱을 못 쓸 때 한 번만 사용
  원격 중지 — 일반 원격 요청 거부
  상태 — 잠금·연결 상태 보기

${HELP_DETAILS}

- 안내

  !파일 …도 같습니다.
  앱 직접 연결은 대화·찾기·파일 받기도 인증해야 합니다.
  비서 서버 DM은 파일 이름 찾기를 제외한 파일 명령에 인증이 필요합니다.
  지정 채널은 찾기도 먼저 인증해야 합니다. 인증 코드는 봇 DM에서만 보내세요.
  비서 서버의 채널 설정은 !디스코드 채널로 확인하세요.`;

// 따옴표를 고려해 나눈다:  파일 이동 "회의 자료.pdf" 문서
export function tokenize(s: string): string[] {
  return commandTokens(s).map((t) => t.text);
}

function commandTokens(s: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  const re = /"([^"]*)"|'([^']*)'|“([^”]*)”|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push({ text: m[1] ?? m[2] ?? m[3] ?? m[4], quoted: m[4] === undefined });
  return out;
}

export type LocalCommand = { help: true } | { action: ActionName; args: ActionArgs };

const VERBS: Record<string, ActionName> = {
  찾기: 'file.search',
  검색: 'file.search',
  열기: 'file.open',
  열어: 'file.open',
  위치: 'file.reveal',
  경로: 'file.reveal',
  보기: 'file.open',
  이동: 'file.move',
  옮기기: 'file.move',
  옮겨: 'file.move',
  복사: 'file.copy',
  이름: 'file.rename',
  이름바꾸기: 'file.rename',
  이름변경: 'file.rename',
  이름수정: 'file.rename',
  폴더: 'file.mkdir',
  새폴더: 'file.mkdir',
  폴더만들기: 'file.mkdir',
  폴더생성: 'file.mkdir',
  폴더등록: 'file.mkdir',
  폴더추가: 'file.mkdir',
  생성: 'file.create',
  생성해: 'file.create',
  등록: 'file.create',
  등록해: 'file.create',
  추가: 'file.create',
  추가해: 'file.create',
  만들기: 'file.create',
  만들어: 'file.create',
  목록: 'file.list',
  백업: 'file.backup',
  삭제: 'file.delete',
  지우기: 'file.delete',
  지워: 'file.delete',
  보내기: 'file.send',
  보내: 'file.send',
  전송: 'file.send'
};

const MAKE_WORDS = ['생성', '생성해', '등록', '등록해', '추가', '추가해', '만들기', '만들어'];

// 이 말이 있으면 정형 명령이 아니라 질문으로 본다. 따옴표 안은 보지 않는다.
const QUESTION = /[?？]|어떻게|방법|알려줘|뭐야|왜|설명/;
const QUOTED = /"[^"]*"|'[^']*'|“[^”]*”/g;

/** 파일 접두어만 통일한다. 파일함·다른 !명령·이름 안의 !는 건드리지 않는다. */
export function normalizeFileText(text: string): string {
  return text.trim().replace(/^!파일(?=\s|$)/, '파일');
}

/** 정형 명령이 아니면 null (AI로 간다). 파일과 !파일은 동일하게 해석한다. */
export function parseLocalCommand(text: string): LocalCommand | null {
  const m = /^파일(?:\s+([\s\S]*))?$/.exec(normalizeFileText(text));
  if (!m) return null;
  const body = m[1] || '';
  const [verbToken, ...parts] = commandTokens(body);
  const verb = verbToken?.text;
  const args = parts.map((t) => t.text);
  if (!verb || verb === '도움말') return { help: true };
  const action = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : undefined;
  if (!action) return null;
  if (QUESTION.test(body.replace(QUOTED, ' '))) return null;
  // 파일 폴더 생성 문서 2026: 단어가 셋 이상일 때만 만들기 말을 뺀다 (둘이면 <위치> <이름>)
  const rest = action === 'file.mkdir' && args.length >= 3 && MAKE_WORDS.includes(args[0]) ? args.slice(1) : args;
  if (action === 'file.search') return rest.length ? { action, args: { query: rest.join(' '), ...(parts.length > 1 ? { openParts: parts } : {}) } } : { help: true };
  if (action === 'file.open' || action === 'file.reveal' || action === 'file.backup' || action === 'file.delete' || action === 'file.send') {
    return rest.length ? { action, args: { target: rest.join(' '), ...(parts.length > 1 ? { openParts: parts } : {}) } } : { help: true };
  }
  if (action === 'file.list') return { action, args: rest.length ? { dest: rest.join(' ') } : {} };
  if (action === 'file.copy' || action === 'file.move') {
    return rest.length ? { action, args: { target: rest.join(' '), transferParts: parts } } : { help: true };
  }
  if (rest.length < 2) return { help: true };
  const last = rest[rest.length - 1];
  const first = rest.slice(0, -1).join(' ');
  if (action === 'file.rename') {
    const targetParts = parts.slice(0, -1);
    return { action, args: { target: first, name: last, ...(targetParts.length > 1 ? { openParts: targetParts } : {}) } };
  }
  if (action === 'file.mkdir' || action === 'file.create') {
    const createParts = rest === args ? parts : parts.slice(1);
    return { action, args: { dest: first, name: last, ...(createParts.length > 2 ? { createParts } : {}) } };
  }
  return { action, args: { target: first, dest: last } };
}
