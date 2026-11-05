// 디스코드 칸의 "연결": 입력한 값으로 먼저 연결해 보고, 되면 저장한다. 안 되면 저장하지 않고 저장된 값으로 되돌린다.
export const READY_WAIT_MS = 30_000;

export interface DiscordInput {
  enabled: boolean;
  apiKey: string;
  userId: string;
}

export interface ConnectTransport {
  status: { error: string };
  waitReady(ms: number): Promise<boolean>;
}

export interface ConnectDeps {
  /** 지금 연결을 끊고 입력한 값으로 시작한다. 시작한 연결을 돌려주고, 실패하면 throw 한다 */
  start: (apiKey: string, userId: string) => Promise<ConnectTransport>;
  /** 입력한 값을 저장한다 */
  save: (input: DiscordInput) => void;
  /** 저장된 값으로 다시 연결한다 (꺼져 있으면 끊는다) */
  restore: () => void;
  /** 이 연결이 아직 지금 연결인가 (기다리는 사이 다른 저장으로 바뀌었으면 false) */
  isCurrent: (t: ConnectTransport) => boolean;
}

export async function connectThenSave(input: DiscordInput, deps: ConnectDeps, waitMs = READY_WAIT_MS): Promise<{ ok: boolean; error: string }> {
  if (!input.enabled) {
    deps.save(input);
    deps.restore();
    return { ok: true, error: '' };
  }
  if (!input.apiKey || !input.userId) return { ok: false, error: '봇 토큰과 내 디스코드 사용자 ID를 넣어 주세요.' };
  let t: ConnectTransport;
  try {
    t = await deps.start(input.apiKey, input.userId);
  } catch (e) {
    const error = (e as Error).message || '연결하지 못했습니다.';
    deps.restore();
    return { ok: false, error };
  }
  const ready = await t.waitReady(waitMs);
  if (!deps.isCurrent(t)) return { ok: false, error: '다른 저장으로 연결이 바뀌어 저장하지 않았습니다.' };
  if (ready) {
    deps.save(input);
    return { ok: true, error: '' };
  }
  const error = t.status.error || '시간 안에 연결되지 않았습니다.';
  deps.restore();
  return { ok: false, error };
}
